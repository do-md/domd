use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};

mod benchmark;
mod cli_server;
#[cfg(target_os = "macos")]
mod untitled_doc;

// ── Native-menu i18n ─────────────────────────────────────────────────────────
//
// The native menu reuses the SAME translation source as the frontend: the very
// same locales/*.json, embedded at build time via include_str!. One dictionary,
// two consumers (React `t()` and this Rust `menu_i18n::t`). Only the `menu.*`
// namespace is read here. System locale is detected via sys-locale.
mod menu_i18n {
    use serde_json::Value;
    use std::sync::OnceLock;

    const EN: &str = include_str!("../../common/i18n/locales/en.json");
    const ZH: &str = include_str!("../../common/i18n/locales/zh.json");
    const JA: &str = include_str!("../../common/i18n/locales/ja.json");

    fn dicts() -> &'static [(&'static str, Value)] {
        static CELL: OnceLock<Vec<(&'static str, Value)>> = OnceLock::new();
        CELL.get_or_init(|| {
            vec![
                ("en", serde_json::from_str(EN).unwrap_or(Value::Null)),
                ("zh", serde_json::from_str(ZH).unwrap_or(Value::Null)),
                ("ja", serde_json::from_str(JA).unwrap_or(Value::Null)),
            ]
        })
    }

    /// Map any BCP-47 tag to one of the shipped locales (mirrors the frontend
    /// `normalizeLocale`): zh-CN -> zh, ja-JP -> ja, everything else -> en.
    pub fn normalize(tag: &str) -> &'static str {
        let l = tag.to_ascii_lowercase();
        if l.starts_with("zh") {
            "zh"
        } else if l.starts_with("ja") {
            "ja"
        } else {
            "en"
        }
    }

    /// The OS's preferred locale, normalized to a shipped locale (default "en").
    pub fn system_locale() -> &'static str {
        sys_locale::get_locale()
            .map(|tag| normalize(&tag))
            .unwrap_or("en")
    }

    /// Look up a dotted key (e.g. "menu.newWindow") for `locale`, falling back
    /// to English, then to the key itself if truly absent.
    pub fn t(locale: &str, key: &str) -> String {
        let find = |loc: &str| dicts().iter().find(|(k, _)| *k == loc).map(|(_, v)| v);
        let lookup = |root: &Value| -> Option<String> {
            let mut cur = root;
            for part in key.split('.') {
                cur = cur.get(part)?;
            }
            cur.as_str().map(|s| s.to_string())
        };
        find(locale)
            .and_then(lookup)
            .or_else(|| find("en").and_then(lookup))
            .unwrap_or_else(|| key.to_string())
    }
}

// Build the full application menu bar for a given locale. Reused by `setup`
// (initial build with the system locale) and the `set_locale` command (runtime
// rebuild when the user changes language in-app). Menu item IDs are stable
// across locales, so the single `on_menu_event` handler keeps working after a
// rebuild.
fn build_app_menu<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
    locale: &str,
) -> tauri::Result<Menu<R>> {
    const APP_ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");
    let about_icon = tauri::image::Image::from_bytes(APP_ICON_PNG).ok();
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("DOMD"))
        .version(Some(env!("CARGO_PKG_VERSION").to_string()))
        .website(Some("https://github.com/do-md/domd"))
        .website_label(Some("github.com/do-md/domd"))
        .icon(about_icon)
        .build();

    let about_item = PredefinedMenuItem::about(
        manager,
        Some(&menu_i18n::t(locale, "menu.about")),
        Some(about_metadata),
    )?;
    let check_updates_item = MenuItem::with_id(
        manager,
        "check-updates",
        menu_i18n::t(locale, "menu.checkUpdates"),
        true,
        None::<&str>,
    )?;
    // App menu title is the bundle name on macOS (system-controlled), so it
    // stays "DOMD" regardless of locale.
    let app_menu = Submenu::with_items(
        manager,
        "DOMD",
        true,
        &[
            &about_item,
            &check_updates_item,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::services(manager, None)?,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::hide(manager, None)?,
            &PredefinedMenuItem::hide_others(manager, None)?,
            &PredefinedMenuItem::show_all(manager, None)?,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::quit(manager, None)?,
        ],
    )?;

    let new_window_item = MenuItem::with_id(
        manager,
        "new-window",
        menu_i18n::t(locale, "menu.newWindow"),
        true,
        Some("Cmd+N"),
    )?;
    let open_url_item = MenuItem::with_id(
        manager,
        "open-url",
        menu_i18n::t(locale, "menu.openUrl"),
        true,
        Some("Cmd+O"),
    )?;
    let close_window_item = MenuItem::with_id(
        manager,
        "close-window",
        menu_i18n::t(locale, "menu.closeWindow"),
        true,
        Some("Cmd+W"),
    )?;
    let save_item = MenuItem::with_id(
        manager,
        "save",
        menu_i18n::t(locale, "menu.save"),
        true,
        Some("Cmd+S"),
    )?;
    let install_cli_item = MenuItem::with_id(
        manager,
        "install-cli",
        menu_i18n::t(locale, "menu.installCli"),
        true,
        None::<&str>,
    )?;
    let file_menu = Submenu::with_items(
        manager,
        &menu_i18n::t(locale, "menu.file"),
        true,
        &[
            &new_window_item,
            &open_url_item,
            &close_window_item,
            &PredefinedMenuItem::separator(manager)?,
            &save_item,
            &PredefinedMenuItem::separator(manager)?,
            &install_cli_item,
        ],
    )?;

    // Edit menu — required on macOS for Cmd+C/X/V/A to work in WebView. The
    // Cut/Copy/Paste/… predefined items are auto-localized by macOS.
    let edit_menu = Submenu::with_items(
        manager,
        &menu_i18n::t(locale, "menu.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(manager, None)?,
            &PredefinedMenuItem::redo(manager, None)?,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::cut(manager, None)?,
            &PredefinedMenuItem::copy(manager, None)?,
            &PredefinedMenuItem::paste(manager, None)?,
            &PredefinedMenuItem::select_all(manager, None)?,
        ],
    )?;

    Menu::with_items(manager, &[&app_menu, &file_menu, &edit_menu])
}

/// The OS's preferred locale, normalized to a shipped locale (en/zh/ja).
/// The webview reads this at startup (when no explicit choice is stored) so the
/// initial UI language matches the native menu.
#[tauri::command]
fn get_system_locale() -> String {
    menu_i18n::system_locale().to_string()
}

/// Rebuild the native menu bar in `locale`, keeping it in sync with the
/// webview's language. Called from the frontend `setLocale` when running under
/// Tauri. No-op-safe: unknown tags normalize to a shipped locale.
#[tauri::command]
fn set_locale(app: AppHandle, locale: String) -> Result<(), String> {
    let normalized = menu_i18n::normalize(&locale);
    let menu = build_app_menu(&app, normalized).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

// ── macOS app icon ───────────────────────────────────────────────────────────
//
// In dev (`cargo tauri dev`) and sometimes in fresh installs the bundle's
// Info.plist CFBundleIconFile isn't picked up by NSApp at launch, so NSAlert
// dialogs (used by tauri-plugin-dialog's ask/message and by Tauri's About
// panel fallback) render a generic folder icon. Setting
// applicationIconImage explicitly at setup time fixes both.

#[cfg(target_os = "macos")]
fn set_nsapp_icon(png_bytes: &'static [u8]) {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(png_bytes);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

// ── macOS dock menu ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod dock_menu {
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::sel;
    use tauri::AppHandle;

    static HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static MENU_PTR: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn setup(handle: &AppHandle) {
        use objc2::rc::Retained;
        use objc2::{MainThreadMarker, MainThreadOnly};
        use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
        use objc2_foundation::NSString;

        HANDLE.set(handle.clone()).ok();

        unsafe {
            let mtm = MainThreadMarker::new().unwrap();
            let app = NSApplication::sharedApplication(mtm);

            // Build the dock menu
            let menu = NSMenu::new(mtm);
            let title = NSString::from_str("New Window");
            let key = NSString::from_str("");
            let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &title,
                Some(sel!(dockNewWindow:)),
                &key,
            );
            menu.addItem(&item);

            // Leak menu into a raw pointer (lives forever)
            MENU_PTR.store(
                Retained::into_raw(menu) as *mut c_void,
                Ordering::Release,
            );

            // Get the delegate's class so we can add methods to it
            let delegate = app.delegate().expect("app delegate not set");
            let delegate_ptr = Retained::as_ptr(&delegate) as *const AnyObject;
            let cls_ptr = objc2::ffi::object_getClass(delegate_ptr) as *mut AnyClass;

            // applicationDockMenu: → return our stored menu
            objc2::ffi::class_addMethod(
                cls_ptr,
                sel!(applicationDockMenu:),
                std::mem::transmute::<
                    extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut c_void,
                    unsafe extern "C-unwind" fn(),
                >(dock_menu_imp),
                c"@@:@".as_ptr(),
            );

            // dockNewWindow: → create a new window
            objc2::ffi::class_addMethod(
                cls_ptr,
                sel!(dockNewWindow:),
                std::mem::transmute::<
                    extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                    unsafe extern "C-unwind" fn(),
                >(new_window_imp),
                c"v@:@".as_ptr(),
            );

            // applicationShouldTerminate: → review unsaved windows before
            // quitting. tao's delegate doesn't implement this selector, so the
            // Dock "Quit" / Cmd+Q `terminate:` path otherwise hits AppKit's
            // default (NSTerminateNow) and dies without the save sheet. The
            // return type is NSApplicationTerminateReply (NSUInteger → "Q").
            objc2::ffi::class_addMethod(
                cls_ptr,
                sel!(applicationShouldTerminate:),
                std::mem::transmute::<
                    extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
                    unsafe extern "C-unwind" fn(),
                >(should_terminate_imp),
                c"Q@:@".as_ptr(),
            );
        }
    }

    extern "C-unwind" fn dock_menu_imp(
        _this: *mut AnyObject,
        _sel: Sel,
        _app: *mut AnyObject,
    ) -> *mut c_void {
        MENU_PTR.load(Ordering::Acquire)
    }

    extern "C-unwind" fn new_window_imp(
        _this: *mut AnyObject,
        _sel: Sel,
        _sender: *mut AnyObject,
    ) {
        if let Some(h) = HANDLE.get() {
            super::new_empty_window(h);
        }
    }

    // NSApplicationTerminateReply values.
    const NS_TERMINATE_CANCEL: usize = 0;
    const NS_TERMINATE_NOW: usize = 1;

    extern "C-unwind" fn should_terminate_imp(
        _this: *mut AnyObject,
        _sel: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let Some(h) = HANDLE.get() else {
            return NS_TERMINATE_NOW;
        };
        // The terminate we issue ourselves after the review completes — let it
        // through.
        if super::QUITTING.load(Ordering::Acquire) {
            return NS_TERMINATE_NOW;
        }
        let dirty = super::dirty_untitled_labels(h);
        if dirty.is_empty() {
            return NS_TERMINATE_NOW;
        }
        // Cancel this terminate and review the unsaved windows one at a time
        // (we're already on the main thread). The review reissues terminate:
        // once every window is resolved.
        super::QUITTING.store(true, Ordering::Release);
        super::review_queue_then_quit(h.clone(), dirty);
        NS_TERMINATE_CANCEL
    }
}

static WIN_ID: AtomicU32 = AtomicU32::new(0);

pub struct WindowFiles(pub Mutex<HashMap<String, String>>);

/// Per-window `UntitledDoc` (NSDocument subclass) used to drive the native
/// "save changes?" sheet for untitled+dirty docs on macOS. Populated lazily
/// on close request, cleared when the close flow resolves.
#[cfg(target_os = "macos")]
pub struct WindowDocs(pub Mutex<HashMap<String, untitled_doc::WindowDoc>>);

/// Tracks which webview windows have fully mounted and rendered. The
/// editor calls `benchmark_mark_ready` after its first two RAFs, which is
/// the point at which the React tree is hydrated and event listeners
/// (including `cli-insert`) are subscribed. The CLI server waits on this
/// before emitting, so `domd-cli insert` issued right after `new` never
/// races against the page load.
pub struct WindowReady(pub Mutex<HashMap<String, bool>>);

impl WindowReady {
    pub fn mark(&self, label: &str) {
        self.0.lock().unwrap().insert(label.to_string(), true);
    }
    pub fn is_ready(&self, label: &str) -> bool {
        *self.0.lock().unwrap().get(label).unwrap_or(&false)
    }
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

/// Poll-based wait helper. 20ms granularity is fine — page load takes
/// hundreds of ms, the latency difference is invisible.
pub async fn wait_for_window_ready(
    state: &WindowReady,
    label: &str,
    timeout: std::time::Duration,
) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if state.is_ready(label) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    state.is_ready(label)
}

// ── selection / content state pushed from FE ─────────────────────────────────
//
// The webview pushes selection and content snapshots to Rust on change
// (debounced in editor.tsx). The CLI server reads from these maps synchronously
// when answering `selection` / `content` / `list` / `save` requests, so we
// don't need a request/response round-trip back to the webview per query.

/// Mirrors `SelectionState` in @do-md/core-react/editor/type. Field names are
/// snake_case so the JSON shape is identical end-to-end (FE invoke → Rust
/// state → socket response → AI agent).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SelectionState {
    pub has_selection: bool,
    pub selected_text: String,
    pub before: String,
    pub after: String,
    pub before_truncated: bool,
    pub after_truncated: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ContentState {
    pub content: String,
    pub is_dirty: bool,
}

pub struct WindowSelections(pub Mutex<HashMap<String, SelectionState>>);
pub struct WindowContents(pub Mutex<HashMap<String, ContentState>>);

impl WindowSelections {
    pub fn get(&self, label: &str) -> Option<SelectionState> {
        self.0.lock().unwrap().get(label).cloned()
    }
    pub fn set(&self, label: &str, sel: SelectionState) {
        self.0.lock().unwrap().insert(label.to_string(), sel);
    }
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

impl WindowContents {
    pub fn get(&self, label: &str) -> Option<ContentState> {
        self.0.lock().unwrap().get(label).cloned()
    }
    pub fn set(&self, label: &str, content: String, is_dirty: bool) {
        self.0
            .lock()
            .unwrap()
            .insert(label.to_string(), ContentState { content, is_dirty });
    }
    pub fn mark_clean(&self, label: &str) {
        if let Some(s) = self.0.lock().unwrap().get_mut(label) {
            s.is_dirty = false;
        }
    }
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

// ── commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_my_path(window: Window, state: State<WindowFiles>) -> Option<String> {
    state.0.lock().unwrap().get(window.label()).cloned()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_path(window: Window, path: String, state: State<WindowFiles>) {
    let label = window.label().to_string();
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("DOMD")
        .to_string();
    let _ = window.set_title(&filename);
    state.0.lock().unwrap().insert(label, path);
}

/// Turn the editor's raw first-paragraph text into a safe filename for the
/// macOS Save dialog's `nameFieldStringValue`. Strips illegal/control chars,
/// collapses whitespace, char-truncates (not byte — keep UTF-8 intact), and
/// appends `.md` if missing. Empty / fully-stripped input falls back to
/// `Untitled.md`.
#[tauri::command]
fn sanitize_filename(title: String) -> String {
    const MAX_CHARS: usize = 80;
    const ILLEGAL: &[char] = &['/', '\\', ':', '<', '>', '"', '|', '?', '*'];

    let mut collapsed = String::with_capacity(title.len());
    let mut prev_space = true;
    for c in title.chars() {
        let is_bad = c.is_control() || ILLEGAL.contains(&c);
        let ch = if is_bad || c.is_whitespace() {
            ' '
        } else {
            c
        };
        if ch == ' ' {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }

    let trimmed: String = collapsed
        .chars()
        .take(MAX_CHARS)
        .collect::<String>()
        .trim_matches(|c: char| c == '.' || c == ' ')
        .to_string();

    let stem = if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed
    };

    let lower = stem.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        stem
    } else {
        format!("{}.md", stem)
    }
}

#[tauri::command]
fn force_close_window(window: Window) {
    let _ = window.destroy();
}

fn domd_assets_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".domd").join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Save image bytes to ~/.domd/assets/<name>, skipping the write if a file
/// with the same name already exists (hash-based dedup). Returns the absolute
/// path so the frontend can embed it directly in markdown — staying compatible
/// with other markdown viewers (Typora, VSCode, Obsidian) instead of using a
/// custom URI scheme that only DOMD can resolve.
#[tauri::command]
fn save_image(app: AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
    let path = domd_assets_dir(&app)?.join(&name);
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

/// FE pushes current selection on selection-change (debounced).
#[tauri::command]
fn update_selection(window: Window, state: State<WindowSelections>, sel: SelectionState) {
    state.set(window.label(), sel);
}

/// FE pushes current document content on change (debounced). `is_dirty` is
/// computed FE-side by comparing to the last-saved markdown.
#[tauri::command]
fn update_content(
    window: Window,
    state: State<WindowContents>,
    content: String,
    is_dirty: bool,
) {
    state.set(window.label(), content, is_dirty);
}

// ── window helpers ────────────────────────────────────────────────────────────

pub(crate) fn new_empty_window(app: &AppHandle) -> String {
    let label = format!("w{}", WIN_ID.fetch_add(1, Ordering::SeqCst));
    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("/editor".into()))
        .title("DOMD")
        .inner_size(900.0, 700.0)
        .resizable(true)
        .build();
    if let Ok(win) = result {
        let _ = win.set_focus();
    }
    label
}

pub(crate) fn open_file_window(app: &AppHandle, path: String) -> String {
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("DOMD")
        .to_string();

    let label = format!("w{}", WIN_ID.fetch_add(1, Ordering::SeqCst));

    app.state::<WindowFiles>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), path);

    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("/editor".into()))
        .title(&filename)
        .inner_size(900.0, 700.0)
        .resizable(true)
        .build();

    if let Ok(win) = result {
        let _ = win.set_focus();
    }
    label
}

pub struct OpenOutcome {
    pub window_id: String,
    pub was_already_open: bool,
}

// ── CLI install ───────────────────────────────────────────────────────────────

/// VSCode-style "Install Shell Command in PATH". Resolves the bundled
/// `domd-cli` next to the main executable and symlinks it into
/// `/usr/local/bin/domd-cli`, overwriting any existing entry there. Falls
/// back to an admin-prompted `osascript` invocation when the target dir
/// isn't writable. Idempotent: re-clicking when already linked to the
/// current bundle is a quiet no-op.
#[cfg(target_os = "macos")]
fn install_cli_to_path() {
    use std::path::PathBuf;
    use std::process::Command;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let cli_path = match exe.parent() {
        Some(d) => d.join("domd-cli"),
        None => return,
    };
    if !cli_path.exists() {
        notify_user(
            "Install failed",
            "domd-cli binary not found inside this app bundle.",
        );
        return;
    }

    let target = PathBuf::from("/usr/local/bin/domd-cli");
    let cli_str = cli_path.to_string_lossy().to_string();
    let target_str = target.to_string_lossy().to_string();

    // Already linked to the current bundle? Nothing to do.
    if let Ok(existing) = std::fs::read_link(&target) {
        if existing == cli_path {
            notify_user(
                "Already up to date",
                &format!("{} already points to this DOMD.", target_str),
            );
            return;
        }
    }

    // Try unprivileged first — works on dev machines where /usr/local/bin
    // is user-writable (common with Homebrew on Intel macs).
    let _ = std::fs::remove_file(&target);
    if std::os::unix::fs::symlink(&cli_path, &target).is_ok() {
        notify_user(
            "domd-cli installed",
            &format!("Linked {} → {}", target_str, cli_str),
        );
        return;
    }

    // Escalate. `rm -f` first so a stale symlink/file from a previous install
    // (possibly pointing at a different .app) is replaced cleanly.
    let q = |s: &str| s.replace('\'', "'\\''");
    let script = format!(
        r#"do shell script "mkdir -p /usr/local/bin && rm -f '{}' && ln -s '{}' '{}'" with administrator privileges"#,
        q(&target_str),
        q(&cli_str),
        q(&target_str),
    );
    match Command::new("osascript").args(["-e", &script]).status() {
        Ok(status) if status.success() => {
            notify_user(
                "domd-cli installed",
                &format!("Linked {} → {}", target_str, cli_str),
            );
        }
        _ => {
            notify_user(
                "Install cancelled",
                "Could not create symlink in /usr/local/bin.",
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn notify_user(title: &str, body: &str) {
    use std::process::Command;
    let script = format!(
        r#"display dialog "{}" with title "{}" buttons {{"OK"}} default button "OK""#,
        body.replace('\\', "\\\\").replace('"', "\\\""),
        title.replace('\\', "\\\\").replace('"', "\\\""),
    );
    let _ = Command::new("osascript").args(["-e", &script]).status();
}

/// Open a file, reusing any existing empty (no-file) window to avoid showing
/// a stray drop-zone window alongside the file window.
///
/// Returns the window label that ended up owning the file, plus a flag
/// telling the caller whether that window was already showing this file
/// (so the AI agent knows "I just opened this" vs "user was already on it").
pub(crate) fn open_or_reuse(app: &AppHandle, path: String) -> OpenOutcome {
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("DOMD")
        .to_string();

    let state = app.state::<WindowFiles>();
    let mut files = state.0.lock().unwrap();
    let all_windows = app.webview_windows();

    // If this file is already open, just focus that window
    if let Some(label) = files.iter().find(|(_, p)| p.as_str() == path).map(|(l, _)| l.clone()) {
        if let Some(win) = all_windows.get(&label) {
            drop(files);
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
            }
            let _ = win.set_focus();
            return OpenOutcome {
                window_id: label,
                was_already_open: true,
            };
        }
        // Window was closed but entry remains — remove stale entry and continue
        files.remove(&label);
    }

    // Find any open window that hasn't been assigned a file yet
    let empty_label = all_windows
        .iter()
        .find(|(label, _)| !files.contains_key(label.as_str()))
        .map(|(label, _)| label.clone());

    if let Some(label) = empty_label {
        files.insert(label.clone(), path.clone());
        drop(files);
        // Unmark ready: the empty window was ready, but now we're loading new
        // content into it; the AI shouldn't see "ready" until the new content
        // is rendered. benchmark_mark_ready fires again post-mount.
        app.state::<WindowReady>().remove(&label);
        if let Some(win) = app.webview_windows().get(&label) {
            let _ = win.set_title(&filename);
            let _ = win.set_focus();
            let _ = win.emit_to(label.as_str(), "open-file", &path);
        }
        return OpenOutcome {
            window_id: label,
            was_already_open: false,
        };
    }
    drop(files);

    // All windows already have files — open a new one
    let label = open_file_window(app, path);
    OpenOutcome {
        window_id: label,
        was_already_open: false,
    }
}

// ── native (macOS) close flow ────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn start_native_close_flow(app: AppHandle, label: String, content: String) {
    start_native_close_flow_with(app, label, content, None);
}

/// Like `start_native_close_flow`, but runs `then(should_close)` once the user
/// resolves the save sheet (after the window has been destroyed on Save / Don't
/// Save, or left untouched on Cancel). Used by the quit flow to review each
/// untitled-dirty window in turn.
#[cfg(target_os = "macos")]
fn start_native_close_flow_with(
    app: AppHandle,
    label: String,
    content: String,
    then: Option<Box<dyn FnOnce(bool)>>,
) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    // If we can't start the native flow (window gone, not on main thread),
    // treat it as "nothing to confirm" so a quit sequence keeps advancing
    // rather than stalling.
    let bail = |then: Option<Box<dyn FnOnce(bool)>>| {
        if let Some(t) = then {
            t(true);
        }
    };
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return bail(then),
    };
    let webview_window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => return bail(then),
    };
    let ns_window_ptr = match webview_window.ns_window() {
        Ok(p) => p as *mut NSWindow,
        Err(_) => return bail(then),
    };

    let suggested = suggest_name_from_content(&content);
    let doc = untitled_doc::UntitledDoc::new(mtm, suggested);
    // SAFETY: Tauri-owned NSWindow lives at least until the window is
    // destroyed; the close flow finishes before that.
    unsafe { doc.set_ns_window(&*ns_window_ptr) };

    let app_for_cb = app.clone();
    let label_for_cb = label.clone();
    let callback: Box<dyn FnOnce(bool, Option<String>)> =
        Box::new(move |should_close, saved_path| {
            // Clean up the doc on the next runloop tick — calling
            // `state::remove` synchronously from inside the doc's own
            // selector would decrement its retain count mid-call. We let
            // AppKit unwind first.
            let app_drop = app_for_cb.clone();
            let label_drop = label_for_cb.clone();
            let _ = app_for_cb.run_on_main_thread(move || {
                app_drop
                    .state::<WindowDocs>()
                    .0
                    .lock()
                    .unwrap()
                    .remove(&label_drop);
            });

            if !should_close {
                if let Some(then) = then {
                    then(false);
                }
                return;
            }

            if let Some(path) = saved_path {
                app_for_cb
                    .state::<WindowFiles>()
                    .0
                    .lock()
                    .unwrap()
                    .insert(label_for_cb.clone(), path.clone());
                if let Some(win) = app_for_cb.get_webview_window(&label_for_cb) {
                    let filename = std::path::Path::new(&path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("DOMD")
                        .to_string();
                    let _ = win.set_title(&filename);
                }
            }

            if let Some(win) = app_for_cb.get_webview_window(&label_for_cb) {
                let _ = win.destroy();
            }

            if let Some(then) = then {
                then(true);
            }
        });

    doc.begin_close(content.into_bytes(), callback);

    // Hold a strong ref in WindowDocs so the doc outlives this function
    // (canCloseDocument is async — the delegate fires later).
    app.state::<WindowDocs>()
        .0
        .lock()
        .unwrap()
        .insert(label, untitled_doc::WindowDoc::new(doc));
}

// ── native (macOS) quit flow ─────────────────────────────────────────────────
//
// Dock "Quit" / Cmd+Q route through RunEvent::ExitRequested — they do NOT fire
// per-window CloseRequested, so without this the untitled "save changes?" sheet
// is skipped and unsaved windows die silently. We intercept the exit, review
// each untitled-dirty window through the same NSDocument sheet one at a time,
// then quit for real once they're all resolved. Cancel aborts the quit.

/// Set while a quit is being orchestrated so the `app.exit(0)` we issue at the
/// end isn't itself intercepted as a fresh exit to review.
#[cfg(target_os = "macos")]
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Really terminate the app. Goes through `NSApp terminate:` (which re-enters
/// our `applicationShouldTerminate:` — guarded by `QUITTING` so it returns
/// NSTerminateNow) so the shutdown follows the normal AppKit/tao path.
#[cfg(target_os = "macos")]
fn terminate_now(app: &AppHandle) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    match MainThreadMarker::new() {
        Some(mtm) => {
            let nsapp = NSApplication::sharedApplication(mtm);
            nsapp.terminate(None);
        }
        None => app.exit(0),
    }
}

/// Labels of windows that would prompt on close: untitled (no path) + dirty.
/// These mirror the per-window CloseRequested gate exactly.
#[cfg(target_os = "macos")]
fn dirty_untitled_labels(app: &AppHandle) -> Vec<String> {
    let files = app.state::<WindowFiles>();
    let files = files.0.lock().unwrap();
    let contents = app.state::<WindowContents>();
    app.webview_windows()
        .into_keys()
        .filter(|label| {
            !files.contains_key(label)
                && contents.get(label).map_or(false, |c| c.is_dirty)
        })
        .collect()
}

/// Review the remaining `queue` of untitled-dirty windows one at a time, then
/// `app.exit(0)`. On Cancel, clears `QUITTING` and stops (leaving every
/// still-open window untouched). Must be called on the main thread.
#[cfg(target_os = "macos")]
fn review_queue_then_quit(app: AppHandle, mut queue: Vec<String>) {
    loop {
        let Some(label) = queue.pop() else {
            // All untitled-dirty windows resolved — quit for real. Remaining
            // windows (saved or clean) close as part of termination.
            terminate_now(&app);
            return;
        };
        // Skip windows that vanished or were saved/cleaned since the snapshot.
        let still_pending = {
            let files = app.state::<WindowFiles>();
            let untitled = !files.0.lock().unwrap().contains_key(&label);
            let dirty = app
                .state::<WindowContents>()
                .get(&label)
                .map_or(false, |c| c.is_dirty);
            untitled && dirty && app.get_webview_window(&label).is_some()
        };
        if !still_pending {
            continue;
        }
        let content = app
            .state::<WindowContents>()
            .get(&label)
            .map(|c| c.content)
            .unwrap_or_default();
        let _ = app.get_webview_window(&label).map(|w| w.set_focus());
        let app_for_then = app.clone();
        start_native_close_flow_with(
            app.clone(),
            label,
            content,
            Some(Box::new(move |should_close| {
                if should_close {
                    review_queue_then_quit(app_for_then, queue);
                } else {
                    // User cancelled — abort the whole quit.
                    QUITTING.store(false, Ordering::SeqCst);
                }
            })),
        );
        return;
    }
}

/// Cheap suggestion: first non-blank line of the markdown, stripped of
/// `#` markers, sanitized through the same logic as the menu Save path.
#[cfg(target_os = "macos")]
fn suggest_name_from_content(md: &str) -> String {
    let first = md
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim_start_matches('#')
        .trim();
    sanitize_filename(first.to_string())
}

// ── entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    // `--cli-bootstrap` is passed by `domd-cli` when it has to launch the app
    // to service a `new`/`open` command. In that case the CLI command opens the
    // window, so `setup()` must NOT also create a default one (that's the
    // "extra window" bug).
    let cli_bootstrap = args.iter().any(|a| a == "--cli-bootstrap");
    let cli_file: Option<String> = args
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
        .cloned();

    let builder = tauri::Builder::default()
        .manage(WindowFiles(Mutex::new(HashMap::new())))
        .manage(WindowReady(Mutex::new(HashMap::new())))
        .manage(WindowSelections(Mutex::new(HashMap::new())))
        .manage(WindowContents(Mutex::new(HashMap::new())));
    #[cfg(target_os = "macos")]
    let builder = builder.manage(WindowDocs(Mutex::new(HashMap::new())));
    let app = builder
        .invoke_handler(tauri::generate_handler![
            get_my_path,
            read_file,
            write_file,
            set_window_path,
            sanitize_filename,
            force_close_window,
            save_image,
            read_file_bytes,
            update_selection,
            update_content,
            get_system_locale,
            set_locale,
            benchmark::benchmark_mark_ready,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let label = window.label().to_string();
                    let app = window.app_handle();
                    let has_path =
                        app.state::<WindowFiles>().0.lock().unwrap().contains_key(&label);
                    if has_path {
                        // Saved file — let it close.
                        return;
                    }
                    // Pathless. Check dirty + content from the FE-pushed
                    // snapshot.
                    let content_state = app.state::<WindowContents>().get(&label);
                    let is_dirty = content_state.as_ref().map_or(false, |c| c.is_dirty);
                    if !is_dirty {
                        // Blank or untouched — let it close.
                        return;
                    }
                    #[cfg(target_os = "macos")]
                    {
                        let content = content_state
                            .map(|c| c.content)
                            .unwrap_or_default();
                        api.prevent_close();
                        // Trigger the native NSDocument flow on the main
                        // thread. Errors are silent — worst case the window
                        // stays open and the user can click X again.
                        let app_clone = app.clone();
                        let label_clone = label.clone();
                        let _ = window.run_on_main_thread(move || {
                            start_native_close_flow(app_clone, label_clone, content);
                        });
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let label = window.label().to_string();
                    let app = window.app_handle();
                    app.state::<WindowFiles>().0.lock().unwrap().remove(&label);
                    app.state::<WindowReady>().remove(&label);
                    app.state::<WindowSelections>().remove(&label);
                    app.state::<WindowContents>().remove(&label);
                    #[cfg(target_os = "macos")]
                    {
                        app.state::<WindowDocs>().0.lock().unwrap().remove(&label);
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.handle().plugin(tauri_plugin_process::init())?;

            // ── App icon ─────────────────────────────────────────────────────
            // Embedded for NSAlert dialogs (via NSApp's applicationIconImage —
            // `tauri-plugin-dialog`'s ask/message render on NSAlert, which picks
            // up its icon from there). The About panel gets its own copy inside
            // build_app_menu.
            #[cfg(target_os = "macos")]
            {
                const APP_ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");
                set_nsapp_icon(APP_ICON_PNG);
            }

            // ── Menu bar ─────────────────────────────────────────────────────
            // Built for the OS locale; the webview re-invokes `set_locale` to
            // rebuild it whenever the in-app language changes. App menu (DOMD)
            // owns About + Check for Updates (conventional macOS spot).
            let menu = build_app_menu(app, menu_i18n::system_locale())?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id() == "new-window" {
                    new_empty_window(app);
                } else if event.id() == "close-window" {
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let _ = win.close();
                    }
                } else if event.id() == "save" {
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let _ = win.emit_to(win.label(), "menu-save", ());
                    }
                } else if event.id() == "open-url" {
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let _ = win.emit_to(win.label(), "menu-open-url", ());
                    }
                } else if event.id() == "install-cli" {
                    #[cfg(target_os = "macos")]
                    std::thread::spawn(|| install_cli_to_path());
                } else if event.id() == "check-updates" {
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let _ = win.emit_to(win.label(), "menu-check-updates", ());
                    }
                }
            });

            // ── Dock menu (macOS) ────────────────────────────────────────────
            #[cfg(target_os = "macos")]
            dock_menu::setup(app.handle());

            // ── Initial window ───────────────────────────────────────────────
            // No window is declared in tauri.conf.json — we create it here so a
            // CLI-bootstrapped launch can stay window-less and let the incoming
            // `new`/`open` command open exactly one window.
            if let Some(path) = cli_file {
                open_or_reuse(app.handle(), path);
            } else if !cli_bootstrap {
                // Plain launch (Finder double-click on the app, `open -a`, etc.)
                // — open one empty editor. A Finder open of a `.md` arrives
                // later via RunEvent::Opened and reuses this empty window.
                new_empty_window(app.handle());
            }

            // ── CLI server (Unix socket at ~/.domd/cli.sock) ─────────────────
            tauri::async_runtime::spawn(cli_server::run(app.handle().clone()));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // RunEvent::Opened fires on macOS for file associations (double-click / Open With).
    // IMPORTANT: do NOT call WebviewWindowBuilder::build() directly here — this
    // callback runs on the main thread, and build() internally tries to dispatch
    // back to the main thread, causing a deadlock that freezes Finder.
    // Spawn onto the async runtime instead (same thread pool as invoke handlers,
    // which we confirmed works via open_test_file).
    app.run(move |handle, event| {
        match event {
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if url.scheme() == "file" {
                        if let Ok(pb) = url.to_file_path() {
                            let p = pb.to_string_lossy().to_string();
                            if p.ends_with(".md") || p.ends_with(".markdown") {
                                let h = handle.clone();
                                tauri::async_runtime::spawn(async move {
                                    // RunEvent::Opened can fire before the initial
                                    // window is registered in webview_windows().
                                    // Poll until ready so open_or_reuse can reuse it.
                                    for _ in 0..40 {
                                        if !h.webview_windows().is_empty() {
                                            break;
                                        }
                                        tokio::time::sleep(
                                            std::time::Duration::from_millis(25),
                                        ).await;
                                    }
                                    open_or_reuse(&h, p);
                                });
                            }
                        }
                    }
                }
            }
            // Dock "Quit" / Cmd+Q: review untitled-dirty windows before quitting
            // (they don't get per-window CloseRequested events).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Our own app.exit(0) at the end of the review re-enters here —
                // let it pass through.
                if QUITTING.load(Ordering::SeqCst) {
                    return;
                }
                let dirty = dirty_untitled_labels(handle);
                if dirty.is_empty() {
                    return; // nothing unsaved — quit normally
                }
                api.prevent_exit();
                QUITTING.store(true, Ordering::SeqCst);
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    review_queue_then_quit(h, dirty);
                });
            }
            _ => {}
        }
    });
}
