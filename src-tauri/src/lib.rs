use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};

mod benchmark;
mod cli_server;
mod collab_db;
mod file_watch;
#[cfg(target_os = "macos")]
mod print;
#[cfg(target_os = "macos")]
mod titlebar;
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

    // Cmd+N opens a TAB in the current window and Shift+Cmd+N a new window —
    // the shape every tabbed macOS app uses. Both are menu entries so the
    // binding is discoverable and so the accelerators are owned in one place.
    let new_tab_item = MenuItem::with_id(
        manager,
        "new-tab",
        menu_i18n::t(locale, "menu.newTab"),
        true,
        Some("Cmd+N"),
    )?;
    let new_window_item = MenuItem::with_id(
        manager,
        "new-window",
        menu_i18n::t(locale, "menu.newWindow"),
        true,
        Some("Shift+Cmd+N"),
    )?;
    let open_url_item = MenuItem::with_id(
        manager,
        "open-url",
        menu_i18n::t(locale, "menu.openUrl"),
        true,
        Some("Cmd+O"),
    )?;
    let close_tab_item = MenuItem::with_id(
        manager,
        "close-tab",
        menu_i18n::t(locale, "menu.closeTab"),
        true,
        Some("Cmd+W"),
    )?;
    let close_window_item = MenuItem::with_id(
        manager,
        "close-window",
        menu_i18n::t(locale, "menu.closeWindow"),
        true,
        Some("Shift+Cmd+W"),
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
            &new_tab_item,
            &new_window_item,
            &open_url_item,
            &close_tab_item,
            &close_window_item,
            &PredefinedMenuItem::separator(manager)?,
            &save_item,
            &PredefinedMenuItem::separator(manager)?,
            &install_cli_item,
        ],
    )?;

    // Edit menu — required on macOS for Cmd+C/X/V/A to work in WebView. The
    let undo_item = MenuItem::with_id(
        manager,
        "undo",
        menu_i18n::t(locale, "menu.undo"),
        true,
        Some("CmdOrCtrl+Z"),
    )?;
    let redo_item = MenuItem::with_id(
        manager,
        "redo",
        menu_i18n::t(locale, "menu.redo"),
        true,
        Some("CmdOrCtrl+Shift+Z"),
    )?;
    let select_all_item = MenuItem::with_id(
        manager,
        "select-all",
        menu_i18n::t(locale, "menu.selectAll"),
        true,
        Some("CmdOrCtrl+A"),
    )?;

    // Cut/Copy/Paste/… predefined items are auto-localized by macOS.
    let edit_menu = Submenu::with_items(
        manager,
        &menu_i18n::t(locale, "menu.edit"),
        true,
        &[
            // Undo / redo / select-all are the KERNEL's, not the responder
            // chain's. The predefined items carry the standard key
            // equivalents, so macOS claimed Cmd+Z / Cmd+Shift+Z / Cmd+A and
            // sent undo:/selectAll: down the responder chain, where WKWebView
            // ran its own native editing command — the editor's model never
            // saw the keystroke, and the menu entries did nothing. Custom
            // items instead, dispatched to the frontend like Save and Open
            // URL already are, so the menu drives the same commands the
            // kernel binds on the editable root.
            &undo_item,
            &redo_item,
            &PredefinedMenuItem::separator(manager)?,
            &PredefinedMenuItem::cut(manager, None)?,
            &PredefinedMenuItem::copy(manager, None)?,
            &PredefinedMenuItem::paste(manager, None)?,
            &select_all_item,
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
    // Rebuild ONLY on a real language change. The webview invokes this on
    // every launch to align the menu with its own locale, which is normally
    // the locale the menu was already built with in `setup` — so the default
    // path used to replace the whole menu bar with an identical one.
    //
    // That is not free on macOS: the discarded menu's items keep their key
    // equivalents registered, so a keystroke can be delivered to an item of a
    // menu that is no longer on screen. Observed as Cmd+W triggering Undo
    // while File > Close Window still worked, and as the pairing shifting
    // between launches — the give-away that two menus were live at once.
    if *MENU_LOCALE.lock().unwrap() == Some(normalized) {
        return Ok(());
    }
    let menu = build_app_menu(&app, normalized).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    // Recorded only once the swap succeeded. A failed rebuild must not leave the
    // cache claiming a locale the menu bar is not built for: the guard is an
    // exact match, so the retry the next window would make becomes a no-op and
    // the menu stays stranded in the old language until the app restarts.
    *MENU_LOCALE.lock().unwrap() = Some(normalized);
    Ok(())
}

/// Locale the native menu bar is currently built for. Guards the rebuild in
/// `set_locale` so an unchanged locale does not swap the menu for a copy.
static MENU_LOCALE: Mutex<Option<&'static str>> = Mutex::new(None);

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

/// Every file path open as a TAB in each window, pushed from the frontend
/// whenever the tab set changes.
///
/// `WindowFiles` records one path per window — the document the window was
/// last assigned — which is no longer the whole story now that a window can
/// hold several. Two things read this instead:
///
///  * `open_or_reuse`, so opening a file already present in some window's tab
///    strip focuses that window and activates the tab rather than opening a
///    duplicate;
///  * the file watcher, so background tabs are watched too and not just the
///    window's last-assigned document.
/// One open tab, as the frontend sees it.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    /// None for a document that has never been saved.
    pub path: Option<String>,
    pub is_dirty: bool,
    /// The tab currently on screen. Its text also streams through
    /// `update_content` every 150ms, so for the ACTIVE tab that stream is
    /// the fresher source and the close gates prefer it (see
    /// `unsaved_untitled_contents`). A background tab's snapshot here is
    /// exact: nothing edits a background runtime, so it cannot go stale.
    pub is_active: bool,
    /// Sent for every DIRTY tab — the tabs whose text a close could be
    /// asked to preserve. A never-saved tab carries the document BODY (what
    /// the native save sheet writes to the user's chosen path); a
    /// path-backed tab carries the FULL file, frontmatter included, because
    /// `flush_dirty_saved_tabs` writes these bytes verbatim and a body-only
    /// write would strip the document's identity block.
    pub content: Option<String>,
}

pub struct WindowTabs(pub Mutex<HashMap<String, Vec<TabInfo>>>);

impl WindowTabs {
    pub fn set(&self, label: &str, tabs: Vec<TabInfo>) {
        self.0.lock().unwrap().insert(label.to_string(), tabs);
    }

    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }

    /// The window holding this path in a tab, if any.
    pub fn find_window_with_path(&self, path: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, tabs)| {
                tabs.iter().any(|t| t.path.as_deref() == Some(path))
            })
            .map(|(label, _)| label.clone())
    }

    /// Snapshot of (window label, tab path) pairs — used by the watcher.
    pub fn entries(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(label, tabs)| {
                tabs.iter().filter_map(move |t| {
                    t.path.as_ref().map(|p| (label.clone(), p.clone()))
                })
            })
            .collect()
    }

    /// Has the frontend reported tab state for this window yet?
    pub fn knows(&self, label: &str) -> bool {
        self.0.lock().unwrap().contains_key(label)
    }

    /// How many tabs the frontend last reported for this window (0 when it
    /// has not reported yet). Drives the ⌘W menu routing: with one tab the
    /// frontend's close-tab handler would just close the window anyway, so
    /// Rust closes it directly and the shortcut can never go dead.
    pub fn tab_count(&self, label: &str) -> usize {
        self.0
            .lock()
            .unwrap()
            .get(label)
            .map(|tabs| tabs.len())
            .unwrap_or(0)
    }

    /// Every (path, full file content) pair for dirty PATH-BACKED tabs — the
    /// documents autosave would have written moments later, whose pending
    /// debounce a window close would otherwise discard. Content includes the
    /// frontmatter block (see TabInfo::content); callers write it verbatim.
    pub fn dirty_saved_files(&self, label: &str) -> Vec<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .get(label)
            .map(|tabs| {
                tabs.iter()
                    .filter(|t| t.is_dirty)
                    .filter_map(|t| match (&t.path, &t.content) {
                        (Some(p), Some(c)) => Some((p.clone(), c.clone())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// The content of EVERY tab holding unsaved, never-saved work in this
/// window, in strip order — what the close/quit review has to walk before
/// the window may be destroyed. One entry per dirty untitled tab: reviewing
/// only the first and then destroying the window would discard the rest
/// without a prompt, which is the exact hole per-tab reporting exists to
/// close.
///
/// Tab state is authoritative once the frontend has reported it, because it
/// covers every document in the window rather than just the one on screen.
/// For the ACTIVE tab the `update_content` stream (150ms cadence) is fresher
/// than the tab snapshot — the snapshot only refreshes when tab STATE
/// changes, not while text is typed into an already-dirty document — so it
/// wins. The per-window snapshot remains the fallback for anything that has
/// not reported tabs (a window still starting up).
pub(crate) fn unsaved_untitled_contents(app: &AppHandle, label: &str) -> Vec<String> {
    let tabs_state = app.state::<WindowTabs>();
    if tabs_state.knows(label) {
        let fresh_active: Option<String> = app
            .state::<WindowContents>()
            .get(label)
            .map(|c| c.content);
        return tabs_state
            .0
            .lock()
            .unwrap()
            .get(label)
            .map(|tabs| {
                tabs.iter()
                    .filter(|t| t.is_dirty && t.path.is_none())
                    .map(|t| {
                        let snapshot =
                            t.content.clone().unwrap_or_default();
                        if t.is_active {
                            fresh_active.clone().unwrap_or(snapshot)
                        } else {
                            snapshot
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    let has_path = app
        .state::<WindowFiles>()
        .0
        .lock()
        .unwrap()
        .contains_key(label);
    if has_path {
        return Vec::new();
    }
    let content_state = app.state::<WindowContents>().get(label);
    if content_state.as_ref().map_or(false, |c| c.is_dirty) {
        return vec![content_state.map(|c| c.content).unwrap_or_default()];
    }
    Vec::new()
}

/// Write every dirty path-backed tab's pending text to its own file — the
/// save autosave was already going to perform, issued now because the window
/// is closing and the debounce timer will not survive it. Never touches
/// never-saved documents (those go through the save sheet), and skips writes
/// whose bytes already match the disk file: rewriting identical content only
/// bumps mtime and trips other editors' conflict detection (Typora's
/// "changed by another application").
pub(crate) fn flush_dirty_saved_tabs(app: &AppHandle, label: &str) {
    for (path, content) in app.state::<WindowTabs>().dirty_saved_files(label) {
        match std::fs::read_to_string(&path) {
            Ok(existing) if existing == content => continue,
            _ => {}
        }
        let _ = std::fs::write(&path, content);
    }
}

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

/// FE mirrors the collaboration session state (live room + online peer count
/// + version-history availability) so the native titlebar buttons can
/// reflect it. No-op off macOS.
#[tauri::command]
fn set_collab_state(window: Window, active: bool, peers: u32, versioning: bool) {
    #[cfg(target_os = "macos")]
    titlebar::set_state(&window, active, peers, versioning);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, active, peers, versioning);
}

/// FE mirrors the AI collaboration state (enabled with at least one agent)
/// so the titlebar's sparkles button can show its status tint. No-op off
/// macOS.
#[tauri::command]
fn set_ai_state(window: Window, active: bool) {
    #[cfg(target_os = "macos")]
    titlebar::set_ai_state(&window, active);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, active);
}

/// FE mirrors whether formatting is possible (editable + cursor present) so
/// the titlebar's Aa button greys out exactly when the web trigger would.
/// No-op off macOS.
#[tauri::command]
fn set_format_enabled(window: Window, enabled: bool) {
    #[cfg(target_os = "macos")]
    titlebar::set_format_enabled(&window, enabled);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, enabled);
}

/// FE answers a `titlebar-format-request` with the finished menu description
/// (labels, shortcuts, enabled/active); this renders it as a native NSMenu
/// under the Aa button. No-op off macOS.
#[cfg(target_os = "macos")]
#[tauri::command]
fn show_format_menu(window: tauri::WebviewWindow, entries: Vec<titlebar::FormatMenuEntry>) {
    titlebar::show_format_menu(&window, entries);
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn show_format_menu() {}

/// FE mirrors the editor display mode so the native titlebar's "more" menu
/// shows the current checkmark. No-op off macOS.
#[tauri::command]
fn set_editor_mode(window: Window, markdown: bool) {
    #[cfg(target_os = "macos")]
    titlebar::set_mode(&window, markdown);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, markdown);
}

/// Export the window's document as a PDF at `path` (chosen by the frontend
/// via the save dialog). macOS-only: prints the live WKWebView DOM straight
/// to disk — see print.rs.
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                let result = unsafe { print::print_to_pdf(webview.inner().cast(), &path) };
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        // with_webview dispatches to the main thread; park a worker thread
        // (not the async runtime) until the print job reports back.
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv().map_err(|e| e.to_string())?
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, path);
        Err("PDF export is not supported on this platform yet".into())
    }
}

fn domd_assets_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".domd").join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn ai_config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".domd").join("ai.json"))
}

/// AI collaboration config (agents, provider API keys, enabled flag) for the
/// desktop build. The web build keeps it in localStorage; on desktop it
/// lives with the rest of the app's data at ~/.domd/ai.json — user-visible,
/// backupable, and not tied to webview site data. Returns None when the file
/// doesn't exist yet (first run — the frontend then migrates any old
/// localStorage config over).
#[tauri::command]
fn load_ai_config(app: AppHandle) -> Result<Option<String>, String> {
    let path = ai_config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist the AI config JSON at ~/.domd/ai.json. Owner-only permissions:
/// the file carries provider API keys in plain text.
#[tauri::command]
fn save_ai_config(app: AppHandle, content: String) -> Result<(), String> {
    let path = ai_config_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
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

/// FE pushes the state of all open tabs whenever the tab set changes — paths
/// for `open_or_reuse` and the file watcher, dirty/untitled for the close and
/// quit gates.
#[tauri::command]
fn update_tabs(window: Window, state: State<WindowTabs>, tabs: Vec<TabInfo>) {
    state.set(window.label(), tabs);
}

/// Drop this window's assigned path — the counterpart to `set_window_path`.
///
/// With tabs the assignment tracks the ACTIVE document, so activating a
/// never-saved tab has to clear it. The close flow reads this to decide
/// whether a window can close silently (a saved document autosaves; an
/// untitled one needs the "save changes?" sheet), and leaving a stale path
/// behind would let unsaved work disappear without a prompt.
#[tauri::command]
fn clear_window_path(window: Window, state: State<WindowFiles>) {
    state.0.lock().unwrap().remove(window.label());
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
        #[cfg(target_os = "macos")]
        titlebar::install(&win);
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
        #[cfg(target_os = "macos")]
        titlebar::install(&win);
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
    let all_windows = app.webview_windows();

    // Already open as a tab somewhere: focus that window and activate the tab.
    let tabs = app.state::<WindowTabs>();
    if let Some(label) = tabs.find_window_with_path(&path) {
        if let Some(win) = all_windows.get(&label) {
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
            }
            let _ = win.set_focus();
            // Same reasoning as the open-file-in-tab route below: the window
            // is about to show a DIFFERENT document, so readiness has to drop
            // or an immediate `insert` lands in the tab that is on screen now.
            // This route could not clear it before, because Rust cannot tell
            // "switch to a background tab" from "re-activate the tab already
            // showing" — and clearing in the second case left the CLI waiting
            // for a mark no remount would ever produce. The frontend now
            // asserts readiness on both, so clearing here is safe.
            app.state::<WindowReady>().remove(&label);
            let _ = app.emit_to(label.as_str(), "activate-tab", &path);
            return OpenOutcome {
                window_id: label,
                was_already_open: true,
            };
        }
        // Window is gone but the entry lingers — fall through and re-open.
        tabs.remove(&label);
    }

    let state = app.state::<WindowFiles>();
    let mut files = state.0.lock().unwrap();

    // Same check against the per-window assignment. Still needed: a window
    // gets its path from `set_window_path` (save-as, drag-drop) before the
    // frontend's tab push lands, so this is the authority in that gap.
    if let Some(label) = files.iter().find(|(_, p)| p.as_str() == path).map(|(l, _)| l.clone()) {
        if let Some(win) = all_windows.get(&label) {
            drop(files);
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
            }
            let _ = win.set_focus();
            // Readiness drops here too — see the tab-registry route above.
            app.state::<WindowReady>().remove(&label);
            let _ = app.emit_to(label.as_str(), "activate-tab", &path);
            return OpenOutcome {
                window_id: label,
                was_already_open: true,
            };
        }
        // Window was closed but entry remains — remove stale entry and continue
        files.remove(&label);
    }
    drop(files);

    // Not open anywhere: hand it to an existing window as a NEW TAB rather
    // than spawning another window (that was the one-doc-per-window model).
    // Prefer the focused window so the file lands where the user is looking.
    //
    // Both the focused lookup and the fallback walk a deterministic order:
    // `webview_windows()` returns a HashMap, so iterating it directly picks an
    // arbitrary window whenever no window reports focus (or, in principle,
    // when more than one does). Labels are `w<N>` in creation order, so
    // sorting on that index makes the fallback "the most recently opened
    // window" rather than whatever the hash happened to yield.
    let mut labels: Vec<String> = all_windows.keys().cloned().collect();
    labels.sort_by_key(|label| {
        label
            .trim_start_matches('w')
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    let target_label = labels
        .iter()
        .find(|label| {
            all_windows
                .get(*label)
                .map(|w| w.is_focused().unwrap_or(false))
                .unwrap_or(false)
        })
        .cloned()
        .or_else(|| labels.last().cloned());

    if let Some(label) = target_label {
        // Record the window's assigned document BEFORE emitting.
        //
        // The event alone is not enough on a cold start. A Finder open of a
        // `.md` launches the app, `setup` creates an empty window, and
        // RunEvent::Opened lands here while the webview is still booting — so
        // the emit can arrive before anything is listening. The frontend's
        // first act is to ask `get_my_path` for the document this window is
        // meant to show, and with no entry here that returns null and the
        // window blanks itself. Writing it first means the answer is waiting
        // whether or not the event was heard, which is how the one-document
        // build has always worked.
        app.state::<WindowFiles>()
            .0
            .lock()
            .unwrap()
            .insert(label.clone(), path.clone());

        // The window is about to display a DIFFERENT document, so it is no
        // longer ready in the sense the CLI cares about. `benchmark_mark_ready`
        // fires on every editor mount, not just the first, and routing a file
        // into a tab remounts the editor — so clearing here is both correct
        // and self-healing. Without it, `domd-cli open` followed immediately
        // by `insert` races: readiness is still true from the PREVIOUS
        // document and the insert lands in the wrong one.
        app.state::<WindowReady>().remove(&label);
        let _ = app.emit_to(label.as_str(), "open-file-in-tab", &path);
        if let Some(win) = all_windows.get(&label) {
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
            }
            let _ = win.set_focus();
        }
        return OpenOutcome {
            window_id: label,
            was_already_open: false,
        };
    }

    // No windows at all — create one for this file.
    let label = open_file_window(app, path);
    OpenOutcome {
        window_id: label,
        was_already_open: false,
    }
}

// ── native (macOS) close flow ────────────────────────────────────────────────

#[cfg(target_os = "macos")]
/// Present ONE native "save changes?" sheet for one document's content, and
/// hand the outcome to `on_resolved(proceed, saved_path)`. Presentation
/// only: it does not destroy the window and does not decide what happens
/// next — that belongs to `review_untitled_then_destroy`, which may have
/// more documents to review before the window can go.
///
/// `on_resolved` runs on the main thread, on the runloop tick AFTER the
/// sheet's own doc has been dropped from WindowDocs. That ordering is what
/// makes chaining safe: the next sheet inserts a fresh doc under the same
/// window label, and running the continuation before the removal would let
/// the deferred cleanup of sheet N remove the doc of sheet N+1 mid-flight.
///
/// If the sheet cannot be presented at all (window gone, not on the main
/// thread), resolves as "proceed" so a review sequence keeps advancing
/// rather than stalling.
#[cfg(target_os = "macos")]
fn present_save_sheet(
    app: AppHandle,
    label: String,
    content: String,
    // `Send` because resolution hops through run_on_main_thread (whose
    // closure must be Send even when already on the main thread).
    on_resolved: Box<dyn FnOnce(bool, Option<String>) + Send>,
) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => return on_resolved(true, None),
    };
    let webview_window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => return on_resolved(true, None),
    };
    let ns_window_ptr = match webview_window.ns_window() {
        Ok(p) => p as *mut NSWindow,
        Err(_) => return on_resolved(true, None),
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
            // AppKit unwind first, then resolve, in that order (see the
            // function comment for why the order matters).
            let app_drop = app_for_cb.clone();
            let label_drop = label_for_cb.clone();
            let _ = app_for_cb.run_on_main_thread(move || {
                app_drop
                    .state::<WindowDocs>()
                    .0
                    .lock()
                    .unwrap()
                    .remove(&label_drop);
                on_resolved(should_close, saved_path);
            });
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

/// Review EVERY dirty never-saved document in this window through its own
/// save sheet, in strip order, then destroy the window and report
/// `done(true)`. Cancelling any sheet aborts the review with the window —
/// and every document in it — untouched (`done(false)`).
///
/// This is the piece that makes per-tab reporting mean something at close
/// time: resolving one sheet and destroying the window would silently
/// discard the other never-saved tabs, contradicting the reason tab state
/// is reported at all.
#[cfg(target_os = "macos")]
fn review_untitled_then_destroy(
    app: AppHandle,
    label: String,
    mut contents: Vec<String>,
    done: Box<dyn FnOnce(bool) + Send>,
) {
    if contents.is_empty() {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
        done(true);
        return;
    }
    let content = contents.remove(0);
    let app_next = app.clone();
    let label_next = label.clone();
    present_save_sheet(
        app,
        label,
        content,
        Box::new(move |proceed, _saved_path| {
            // A saved path is not adopted into WindowFiles: the window is
            // on its way out either way, and the next sheet (or the
            // destroy) follows immediately.
            if proceed {
                review_untitled_then_destroy(app_next, label_next, contents, done);
            } else {
                done(false);
            }
        }),
    );
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

/// Labels of windows that would prompt on close: holding at least one
/// dirty, never-saved document. These mirror the per-window CloseRequested
/// gate exactly.
#[cfg(target_os = "macos")]
fn dirty_untitled_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| !unsaved_untitled_contents(app, label).is_empty())
        .collect()
}

/// Review the remaining `queue` of untitled-dirty windows one at a time —
/// every never-saved document in each window gets its own sheet — then
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
        // Same gate as CloseRequested, so a window that holds unsaved work in
        // a BACKGROUND tab is reviewed here too rather than quietly quitting.
        if app.get_webview_window(&label).is_none() {
            continue;
        }
        let contents = unsaved_untitled_contents(&app, &label);
        if contents.is_empty() {
            continue;
        }
        let _ = app.get_webview_window(&label).map(|w| w.set_focus());
        let app_for_then = app.clone();
        review_untitled_then_destroy(
            app.clone(),
            label,
            contents,
            Box::new(move |proceed| {
                if proceed {
                    review_queue_then_quit(app_for_then, queue);
                } else {
                    // User cancelled — abort the whole quit.
                    QUITTING.store(false, Ordering::SeqCst);
                }
            }),
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
        .manage(WindowContents(Mutex::new(HashMap::new())))
        .manage(WindowTabs(Mutex::new(HashMap::new())));
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
            update_tabs,
            clear_window_path,
            get_system_locale,
            set_locale,
            set_collab_state,
            set_editor_mode,
            set_ai_state,
            set_format_enabled,
            show_format_menu,
            export_pdf,
            load_ai_config,
            save_ai_config,
            collab_db::collab_put_room,
            collab_db::collab_get_room,
            collab_db::collab_active_host_room,
            collab_db::collab_deactivate_room,
            collab_db::collab_delete_room,
            collab_db::collab_save_doc_bytes,
            collab_db::collab_load_doc_bytes,
            benchmark::benchmark_mark_ready,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let label = window.label().to_string();
                    let app = window.app_handle();
                    // Dirty SAVED documents first: write the autosave their
                    // debounce would have issued moments later. Every
                    // platform, before any prompting — a cancelled sheet
                    // leaves these files exactly as autosave would have.
                    flush_dirty_saved_tabs(app, &label);
                    // Then ask about EVERY never-saved document in the
                    // window, not just the one on screen: with tabs, the
                    // unsaved work that must not be discarded is often in a
                    // tab you cannot see.
                    let contents = unsaved_untitled_contents(app, &label);
                    if contents.is_empty() {
                        // Saved, blank or untouched — let it close.
                        return;
                    }
                    #[cfg(target_os = "macos")]
                    {
                        api.prevent_close();
                        // Trigger the native NSDocument flow on the main
                        // thread. Errors are silent — worst case the window
                        // stays open and the user can click X again.
                        let app_clone = app.clone();
                        let label_clone = label.clone();
                        let _ = window.run_on_main_thread(move || {
                            review_untitled_then_destroy(
                                app_clone,
                                label_clone,
                                contents,
                                Box::new(|_| {}),
                            );
                        });
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        // No native sheet off macOS (pre-existing gap): the
                        // saved flush above still ran, so only never-saved
                        // work is at risk and the close proceeds as before.
                        let _ = (&api, &contents);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let label = window.label().to_string();
                    let app = window.app_handle();
                    app.state::<WindowFiles>().0.lock().unwrap().remove(&label);
                    app.state::<WindowReady>().remove(&label);
                    app.state::<WindowSelections>().remove(&label);
                    app.state::<WindowContents>().remove(&label);
                    app.state::<WindowTabs>().remove(&label);
                    #[cfg(target_os = "macos")]
                    {
                        app.state::<WindowDocs>().0.lock().unwrap().remove(&label);
                        titlebar::forget(&label);
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
            let startup_locale = menu_i18n::system_locale();
            let menu = build_app_menu(app, startup_locale)?;
            app.set_menu(menu)?;
            *MENU_LOCALE.lock().unwrap() = Some(startup_locale);

            app.on_menu_event(|app, event| {
                // Cmd+N / Cmd+W act on TABS when a window is focused, and fall
                // back to window granularity when none is (e.g. the app is
                // active with every window closed). The frontend decides what
                // closing the last tab means — see the domd-close-tab handler.
                if event.id() == "new-tab" {
                    // No focused window means no tab strip to add to.
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let _ = win.emit_to(win.label(), "menu-new-tab", ());
                    } else {
                        new_empty_window(app);
                    }
                } else if event.id() == "new-window" {
                    new_empty_window(app);
                } else if event.id() == "close-tab" {
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        // The frontend owns tab closing only when there are
                        // tabs to tell apart. With one tab (or none reported
                        // yet — a window still booting, where an emit would
                        // hit an unmounted handler and ⌘W would go dead) its
                        // close-tab handler routes through the ordinary
                        // window close anyway, so do that directly. Rust's
                        // own count keeps the shortcut working in every
                        // state the frontend can be in.
                        let label = win.label().to_string();
                        if app.state::<WindowTabs>().tab_count(&label) >= 2 {
                            let _ =
                                win.emit_to(win.label(), "menu-close-tab", ());
                        } else {
                            let _ = win.close();
                        }
                    }
                } else if event.id() == "close-window" {
                    // Always the whole window, whatever the tab state — the
                    // native close flow reviews every tab (see
                    // CloseRequested).
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let _ = win.close();
                    }
                } else if event.id() == "undo"
                    || event.id() == "redo"
                    || event.id() == "select-all"
                {
                    if let Some(win) = app.webview_windows().values().find(|w| {
                        w.is_focused().unwrap_or(false)
                    }) {
                        let event_name = match event.id().0.as_str() {
                            "undo" => "menu-undo",
                            "redo" => "menu-redo",
                            _ => "menu-select-all",
                        };
                        let _ = win.emit_to(win.label(), event_name, ());
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

            // ── Titlebar collaboration buttons (macOS) ───────────────────────
            // Selector registration must precede the first window install.
            #[cfg(target_os = "macos")]
            titlebar::setup(app.handle());

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

            // ── External file-change watcher ─────────────────────────────────
            tauri::async_runtime::spawn(file_watch::run(app.handle().clone()));

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
                // Quit skips per-window CloseRequested, so the dirty-saved
                // flush that closing a window performs must happen here for
                // EVERY window — a dirty saved document in any window would
                // otherwise lose its pending autosave to termination.
                for label in handle.webview_windows().into_keys() {
                    flush_dirty_saved_tabs(handle, &label);
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
