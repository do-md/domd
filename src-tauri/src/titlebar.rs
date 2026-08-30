//! Native macOS titlebar buttons (format + inserts + AI + collaboration).
//!
//! Every editor window gets an NSTitlebarAccessoryViewController pinned to
//! the trailing edge of the title bar with seven SF-symbol buttons:
//!
//!  - format    (textformat)             -> emits `titlebar-format-request`;
//!    the frontend answers with the `show_format_menu` command carrying a
//!    menu DESCRIPTION (labels, shortcuts, enabled/active state) and this
//!    module renders it as a native NSMenu — the "Aa" popover, native.
//!    Item clicks emit `titlebar-format-command` with the item's id.
//!  - table     (tablecells)             -> emits `titlebar-insert-table`
//!  - checklist (checklist)              -> emits `titlebar-insert-checklist`
//!  - ai        (sparkles)               -> emits `titlebar-ai`
//!  - manage    (clock.arrow.circlepath) -> emits `titlebar-versioning`,
//!    hidden until version history is available (any collaboration session —
//!    a live room or the local AI one)
//!  - share     (person.2)               -> emits `titlebar-share`
//!  - more      (ellipsis.circle)        -> pops a native NSMenu mirroring
//!    the web top bar's "more" dropdown: a checkmarked "Markdown mode"
//!    toggle (emits `titlebar-toggle-mode`) and "Export PDF…" (emits
//!    `titlebar-export-pdf`)
//!
//! A second accessory on the LEADING edge (left of the window title, the
//! sidebar-toggle convention) carries the outline button:
//!
//!  - toc       (list.bullet.indent)     -> emits `titlebar-toc`; the
//!    frontend toggles the outline side panel (same panel the web top bar's
//!    left-cluster button and the ⇧⌘O keystroke open — the keystroke works
//!    on desktop too, bound in the webview by TocController)
//!
//! The buttons mirror the web top bar (which the desktop app doesn't render
//! — the native titlebar IS its top bar). The frontend handles the emitted
//! events by calling the editor store (see
//! features/editor/components/editor-app.tsx TitlebarBridge).
//!
//! Click handling follows the dock-menu pattern: action selectors are added
//! to the existing app delegate class at runtime, and the handler resolves
//! which Tauri window owns the clicked button by comparing NSWindow pointers.
//! The webview mirrors state back through commands so the buttons can
//! reflect it: `set_collab_state` (share tint + manage visibility),
//! `set_editor_mode` (more-menu checkmark), `set_ai_state` (ai tint) and
//! `set_format_enabled` (format button enable).
//!
//! The format menu is PULL-based on purpose: block-format state costs a full
//! toMarkdown() and is only correct at open time, so the click asks the
//! frontend, which snapshots state and sends the finished menu back — the
//! same order of operations as the web popover's onToggle refresh.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{sel, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{
    NSButton, NSColor, NSImage, NSLayoutAttribute, NSTitlebarAccessoryViewController, NSView,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::menu_i18n;

static HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Per-window button pointers for later state updates. The accessory view
/// retains the buttons; these are raw pointers only.
#[derive(Clone, Copy)]
struct WinButtons {
    format: usize,
    ai: usize,
    manage: usize,
    share: usize,
    more: usize,
    /// The window's WKWebView (wry's instance), retained once at install
    /// time through tauri's official `with_webview` handle. 0 until the
    /// cache closure has run. Focus restoration uses THIS — never a walk of
    /// wry's private view tree (see restore_webview_focus).
    webview: usize,
}

/// window label -> button pointers.
static BUTTONS: Mutex<Option<HashMap<String, WinButtons>>> = Mutex::new(None);

fn buttons_map(f: impl FnOnce(&mut HashMap<String, WinButtons>)) {
    let mut guard = BUTTONS.lock().unwrap();
    f(guard.get_or_insert_with(HashMap::new));
}

fn buttons_for(label: &str) -> Option<WinButtons> {
    let guard = BUTTONS.lock().unwrap();
    guard.as_ref().and_then(|m| m.get(label).copied())
}

/// window label -> editor is in markdown mode (drives the menu checkmark).
/// Mirrored from the webview via the `set_editor_mode` command.
static MODES: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

/// Label of the window whose "more" menu is currently open. Menu-item action
/// selectors receive the NSMenuItem as sender (no window to resolve from),
/// so the popup records its owner here first. Main-thread serial — at most
/// one popup menu exists at a time.
static MENU_WINDOW: Mutex<Option<String>> = Mutex::new(None);

// Button grid: 28pt buttons on a 30pt step, 4pt leading pad. The manage
// button only exists while a collaboration session is active — when idle it
// is hidden AND the layout collapses (share slides left, container narrows)
// so the titlebar shows no dead gap. `set_state` re-applies the layout on
// every session-state change.
const BTN_SIZE: NSSize = NSSize {
    width: 28.0,
    height: 20.0,
};
const BTN_STEP: f64 = 30.0;
const BTN_PAD: f64 = 4.0;
const BTN_Y: f64 = 3.0;

fn slot_rect(slot: usize) -> NSRect {
    NSRect::new(
        NSPoint::new(BTN_PAD + BTN_STEP * slot as f64, BTN_Y),
        BTN_SIZE,
    )
}

fn container_size(slots: usize) -> NSSize {
    NSSize::new(BTN_PAD * 2.0 + BTN_STEP * slots as f64 - 2.0, 26.0)
}

/// App-lifetime local mouse monitor: a mousedown on a title bar's BLANK area
/// (not on any control) tells that window's webview to blur the editor —
/// the desktop analogue of clicking outside the document on the web.
///
/// Why: WKWebView keeps the page's DOM focus alive across native
/// first-responder changes (no DOM blur is ever delivered), so a click on
/// the title bar used to leave the editor half-alive — caret blinking,
/// keystrokes misrouted, insert commands refusing. Clicking a titlebar
/// BUTTON must NOT blur (they refuse first-responder status and act on the
/// editor's cursor), so control clicks are filtered out. The event is always
/// returned unconsumed — window dragging keeps working.
fn install_blank_click_monitor() {
    use core::ptr::NonNull;
    use objc2_app_kit::{NSEvent, NSEventMask};

    let handler = block2::RcBlock::new(|event_ptr: NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { event_ptr.as_ref() };
        titlebar_blank_mousedown(event);
        event_ptr.as_ptr()
    });
    unsafe {
        // The system copies the block and the monitor lives for the process.
        let _ = NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown,
            &handler,
        );
    }
}

fn titlebar_blank_mousedown(event: &objc2_app_kit::NSEvent) {
    use objc2_app_kit::NSControl;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(handle) = HANDLE.get() else {
        return;
    };
    let Some(window) = event.window(mtm) else {
        return;
    };
    let location = event.locationInWindow();
    let Some(content) = window.contentView() else {
        return;
    };
    // Below the title bar: the page manages its own focus.
    // contentLayoutRect, not contentView.frame — the two agree for standard
    // windows, but only the former excludes the title bar under
    // full-size-content-view styles.
    let layout = window.contentLayoutRect();
    if location.y <= layout.origin.y + layout.size.height {
        return;
    }
    // Title-bar band. Skip clicks that land on any control (accessory
    // buttons, traffic lights) — walking the ancestor chain covers controls
    // wrapped in container views.
    unsafe {
        if let Some(theme_frame) = content.superview() {
            // The theme frame fills the window, so window coordinates are
            // its own coordinate space.
            let mut hit = theme_frame.hitTest(location);
            while let Some(view) = hit {
                if view.downcast_ref::<NSControl>().is_some() {
                    return;
                }
                hit = view.superview();
            }
        }
    }
    let window_ptr = Retained::as_ptr(&window) as *mut c_void;
    for win in handle.webview_windows().values() {
        if win.ns_window().is_ok_and(|ptr| ptr == window_ptr) {
            let _ = win.emit_to(win.label(), "titlebar-blank-mousedown", ());
            return;
        }
    }
}

/// Register the click selectors on the app delegate. Call once at setup,
/// after the delegate exists (same timing as dock_menu::setup).
pub fn setup(handle: &AppHandle) {
    use objc2_app_kit::NSApplication;

    HANDLE.set(handle.clone()).ok();
    install_blank_click_monitor();

    unsafe {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let Some(delegate) = app.delegate() else {
            return;
        };
        let delegate_ptr = Retained::as_ptr(&delegate) as *const AnyObject;
        let cls_ptr = objc2::ffi::object_getClass(delegate_ptr) as *mut AnyClass;

        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarShare:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(share_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarManage:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(manage_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarInsertTable:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(insert_table_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarInsertChecklist:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(insert_checklist_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarMore:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(more_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarToggleMode:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(toggle_mode_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarExportPdf:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(export_pdf_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarAi:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(ai_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarFormatMenu:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(format_menu_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarFormatItem:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(format_item_clicked),
            c"v@:@".as_ptr(),
        );
        objc2::ffi::class_addMethod(
            cls_ptr,
            sel!(domdTitlebarToc:),
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                unsafe extern "C-unwind" fn(),
            >(toc_clicked),
            c"v@:@".as_ptr(),
        );
    }
}

/// Attach the accessory buttons to a freshly built window. Dispatches itself
/// onto the main thread — safe to call right after WebviewWindowBuilder::build.
pub fn install(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        install_on_main(&win, label);
    });
}

/// The app delegate, as the shared action target for every accessory
/// control. The pointer stays valid — NSApplication retains its delegate.
fn delegate_target(mtm: MainThreadMarker) -> Option<*const AnyObject> {
    use objc2_app_kit::NSApplication;
    let app = NSApplication::sharedApplication(mtm);
    let delegate = app.delegate();
    delegate
        .as_ref()
        .map(|d| Retained::as_ptr(d) as *const AnyObject)
}

fn symbol_button(
    mtm: MainThreadMarker,
    symbol: &str,
    fallback_title: &str,
    action: Sel,
    frame: NSRect,
    tooltip: &str,
) -> Retained<NSButton> {
    let target = delegate_target(mtm);

    let button = unsafe {
        let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str(symbol),
            None,
        );
        let button = match image {
            Some(image) => NSButton::buttonWithImage_target_action(
                &image,
                target.map(|p| &*p),
                Some(action),
                mtm,
            ),
            None => NSButton::buttonWithTitle_target_action(
                &NSString::from_str(fallback_title),
                target.map(|p| &*p),
                Some(action),
                mtm,
            ),
        };
        button.setBordered(false);
        button.setFrame(frame);
        button.setToolTip(Some(&NSString::from_str(tooltip)));
        // Toolbar-button discipline (the native equivalent of the web
        // InsertToolbar's pointerdown-preventDefault): clicking must not
        // move key focus away from the editor webview — every action here
        // operates on the editor's current cursor/selection.
        button.setRefusesFirstResponder(true);
        button
    };
    button
}

/// A button carrying a custom (non-SF-symbol) template image.
fn image_button(
    mtm: MainThreadMarker,
    image: &NSImage,
    action: Sel,
    frame: NSRect,
    tooltip: &str,
) -> Retained<NSButton> {
    let target = delegate_target(mtm);
    let button = unsafe {
        let button = NSButton::buttonWithImage_target_action(
            image,
            target.map(|p| &*p),
            Some(action),
            mtm,
        );
        button.setBordered(false);
        button.setFrame(frame);
        button.setToolTip(Some(&NSString::from_str(tooltip)));
        // See symbol_button: never steal key focus from the editor.
        button.setRefusesFirstResponder(true);
        button
    };
    button
}

/// Vertical three-dot glyph for the "more" button, drawn to match the web
/// top bar's EllipsisVerticalIcon (viewBox 24: r=1.8 dots at y 5/12/19,
/// i.e. no enclosing circle — SF Symbols only offers the heavy
/// ellipsis.circle, and a bare vertical ellipsis doesn't exist). A vector
/// drawing-handler image stays crisp on Retina; template mode makes AppKit
/// tint it like the neighboring SF-symbol buttons.
fn vertical_ellipsis_image() -> Retained<NSImage> {
    use objc2::runtime::Bool;
    use objc2_app_kit::NSBezierPath;

    const GLYPH: f64 = 15.0;
    const RADIUS: f64 = 1.15;
    const DOT_YS: [f64; 3] = [3.2, 7.5, 11.8];

    let handler = block2::RcBlock::new(|_rect: NSRect| -> Bool {
        NSColor::blackColor().setFill();
        for cy in DOT_YS {
            let rect = NSRect::new(
                NSPoint::new(GLYPH / 2.0 - RADIUS, cy - RADIUS),
                NSSize::new(RADIUS * 2.0, RADIUS * 2.0),
            );
            NSBezierPath::bezierPathWithOvalInRect(rect).fill();
        }
        Bool::YES
    });
    let image = NSImage::imageWithSize_flipped_drawingHandler(
        NSSize::new(GLYPH, GLYPH),
        false,
        &handler,
    );
    image.setTemplate(true);
    image
}

/// Outline glyph drawn to match the web top bar's TocListIcon (viewBox 24:
/// full-width rules at y 6 and 18, an indented one at y 12, stroke 1.8,
/// round caps). SF Symbols' closest matches (list.bullet.indent and
/// friends) are denser and visually heavier than the neighboring buttons;
/// a custom vector template image keeps the two platforms' outline entries
/// identical and lets AppKit tint it like the SF-symbol buttons.
fn outline_image() -> Retained<NSImage> {
    use objc2::runtime::Bool;
    use objc2_app_kit::{NSBezierPath, NSLineCapStyle};

    const GLYPH: f64 = 15.0;
    const SCALE: f64 = GLYPH / 24.0;
    // (x0, x1, y) in the web icon's 24pt viewBox coordinates.
    const RULES: [(f64, f64, f64); 3] =
        [(4.0, 20.0, 6.0), (9.0, 20.0, 12.0), (4.0, 20.0, 18.0)];

    let handler = block2::RcBlock::new(|_rect: NSRect| -> Bool {
        NSColor::blackColor().setStroke();
        let path = NSBezierPath::bezierPath();
        path.setLineWidth(1.8 * SCALE);
        path.setLineCapStyle(NSLineCapStyle::Round);
        for (x0, x1, y) in RULES {
            path.moveToPoint(NSPoint::new(x0 * SCALE, y * SCALE));
            path.lineToPoint(NSPoint::new(x1 * SCALE, y * SCALE));
        }
        path.stroke();
        Bool::YES
    });
    let image = NSImage::imageWithSize_flipped_drawingHandler(
        NSSize::new(GLYPH, GLYPH),
        false,
        &handler,
    );
    image.setTemplate(true);
    image
}

fn install_on_main(win: &tauri::WebviewWindow, label: String) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // Skip double-install (open_or_reuse can route through here again).
    {
        let guard = BUTTONS.lock().unwrap();
        if guard.as_ref().is_some_and(|m| m.contains_key(&label)) {
            return;
        }
    }
    let Ok(ns_window_ptr) = win.ns_window() else {
        return;
    };
    let locale = menu_i18n::system_locale();

    unsafe {
        let ns_window: &objc2_app_kit::NSWindow =
            &*(ns_window_ptr as *const objc2_app_kit::NSWindow);

        // Layout (trailing edge, left→right): format [Aa], insert group
        // [table, checklist], AI, collaboration group [manage?, share], and
        // the "more" menu button — the web top bar's order. Initial state is
        // the COLLAPSED (no versioning) layout: manage hidden and taking no
        // slot.
        let container = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), container_size(6)),
        );

        let format = symbol_button(
            mtm,
            "textformat",
            "Aa",
            sel!(domdTitlebarFormatMenu:),
            slot_rect(0),
            &menu_i18n::t(locale, "editor.format.button"),
        );

        let table = symbol_button(
            mtm,
            "tablecells",
            "T",
            sel!(domdTitlebarInsertTable:),
            slot_rect(1),
            &menu_i18n::t(locale, "editor.insert.table"),
        );

        let checklist = symbol_button(
            mtm,
            "checklist",
            "C",
            sel!(domdTitlebarInsertChecklist:),
            slot_rect(2),
            &menu_i18n::t(locale, "editor.insert.checklist"),
        );

        let ai = symbol_button(
            mtm,
            "sparkles",
            "AI",
            sel!(domdTitlebarAi:),
            slot_rect(3),
            &menu_i18n::t(locale, "ai.title"),
        );

        let manage = symbol_button(
            mtm,
            "clock.arrow.circlepath",
            "H",
            sel!(domdTitlebarManage:),
            slot_rect(4),
            &menu_i18n::t(locale, "versioning.title"),
        );
        manage.setHidden(true);

        let share = symbol_button(
            mtm,
            "person.2",
            "S",
            sel!(domdTitlebarShare:),
            slot_rect(4),
            &menu_i18n::t(locale, "collab.share"),
        );

        // Vertical three dots, custom-drawn: the web top bar's lightweight
        // "more" icon (SF Symbols only has the visually heavy
        // ellipsis.circle).
        let more = image_button(
            mtm,
            &vertical_ellipsis_image(),
            sel!(domdTitlebarMore:),
            slot_rect(5),
            &menu_i18n::t(locale, "editor.more"),
        );

        container.addSubview(&format);
        container.addSubview(&table);
        container.addSubview(&checklist);
        container.addSubview(&ai);
        container.addSubview(&manage);
        container.addSubview(&share);
        container.addSubview(&more);

        let vc = NSTitlebarAccessoryViewController::new(mtm);
        vc.setView(&container);
        vc.setLayoutAttribute(NSLayoutAttribute::Trailing);
        ns_window.addTitlebarAccessoryViewController(&vc);

        // Leading accessory: the outline toggle, left of the window title —
        // the macOS sidebar-toggle spot (its panel opens from the left, so
        // the entry sits on the left, mirroring the web top bar). Tooltip
        // carries the keystroke, which the webview binds on desktop too.
        let toc_container = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), container_size(1)),
        );
        let toc = image_button(
            mtm,
            &outline_image(),
            sel!(domdTitlebarToc:),
            slot_rect(0),
            &format!("{} \u{21E7}\u{2318}O", menu_i18n::t(locale, "toc.title")),
        );
        toc_container.addSubview(&toc);
        let toc_vc = NSTitlebarAccessoryViewController::new(mtm);
        toc_vc.setView(&toc_container);
        toc_vc.setLayoutAttribute(NSLayoutAttribute::Leading);
        ns_window.addTitlebarAccessoryViewController(&toc_vc);

        buttons_map(|m| {
            m.insert(
                label.clone(),
                WinButtons {
                    format: Retained::into_raw(format) as usize,
                    ai: Retained::into_raw(ai) as usize,
                    manage: Retained::into_raw(manage) as usize,
                    share: Retained::into_raw(share) as usize,
                    more: Retained::into_raw(more) as usize,
                    webview: 0,
                },
            );
        });
        // Cache the window's WKWebView through the OFFICIAL handle (wry's
        // `inner()` via tauri's with_webview) and retain it for the window's
        // lifetime, exactly like the button pointers above. The closure runs
        // on the main thread on a later event-loop turn; until then focus
        // restoration is a graceful no-op.
        //
        // This replaced a depth-first walk of the content view tree: the
        // walk's transient retain/release traffic over wry's PRIVATE views
        // over-released WryWebViewParent in release builds — on the third
        // titlebar click the container hit dealloc while still in the view
        // hierarchy and the AppKit assertion aborted the app.
        let cache_label = label;
        let _ = win.with_webview(move |webview| {
            let ptr = webview.inner() as *const NSView;
            if ptr.is_null() {
                return;
            }
            let retained = (*ptr).retain();
            buttons_map(|m| {
                if let Some(entry) = m.get_mut(&cache_label) {
                    entry.webview = Retained::into_raw(retained) as usize;
                }
            });
        });
        // The accessory VCs must outlive this scope; the window does not take
        // ownership of our Rust handles. Leak them — one set per window,
        // freed with the process.
        let _ = Retained::into_raw(vc);
        let _ = Retained::into_raw(toc_vc);
    }
}

/// Frontend-reported session state -> button appearance. `active` is a live
/// room (share tint + headcount tooltip); `versioning` is any collaboration
/// session with history — a live room or the local AI one — and drives the
/// manage button, exactly like the web top bar's versioningAvailable.
pub fn set_state(window: &Window, active: bool, peers: u32, versioning: bool) {
    let label = window.label().to_string();
    let locale = menu_i18n::system_locale();
    let share_tip = if active {
        format!("{} · {}", menu_i18n::t(locale, "collab.sharingBadge"), peers + 1)
    } else {
        menu_i18n::t(locale, "collab.share")
    };
    let _ = window.run_on_main_thread(move || {
        let Some(buttons) = buttons_for(&label) else {
            return;
        };
        unsafe {
            let share: &NSButton = &*(buttons.share as *const NSButton);
            let manage: &NSButton = &*(buttons.manage as *const NSButton);
            let more: &NSButton = &*(buttons.more as *const NSButton);
            // Reflow, not just hide: with no versioning the manage slot is
            // removed entirely (share and more slide left, container narrows)
            // so the titlebar never shows a dead gap.
            manage.setHidden(!versioning);
            let share_slot = if versioning { 5 } else { 4 };
            share.setFrame(slot_rect(share_slot));
            more.setFrame(slot_rect(share_slot + 1));
            if let Some(container) = share.superview() {
                container.setFrameSize(container_size(share_slot + 2));
            }
            if active {
                share.setContentTintColor(Some(&NSColor::controlAccentColor()));
            } else {
                share.setContentTintColor(None);
            }
            share.setToolTip(Some(&NSString::from_str(&share_tip)));
        }
    });
}

/// FE-reported AI collaboration state (enabled with at least one agent) ->
/// sparkles tint. Mirrors the web top bar's `text-ai` status light, using
/// the same muted purple (--ai: #7b6ba3).
pub fn set_ai_state(window: &Window, active: bool) {
    let label = window.label().to_string();
    let _ = window.run_on_main_thread(move || {
        let Some(buttons) = buttons_for(&label) else {
            return;
        };
        unsafe {
            let ai: &NSButton = &*(buttons.ai as *const NSButton);
            if active {
                let tint = NSColor::colorWithSRGBRed_green_blue_alpha(
                    0x7b as f64 / 255.0,
                    0x6b as f64 / 255.0,
                    0xa3 as f64 / 255.0,
                    1.0,
                );
                ai.setContentTintColor(Some(&tint));
            } else {
                ai.setContentTintColor(None);
            }
        }
    });
}

/// FE-reported "can format" (editable + has a cursor) -> Aa button enable.
/// The web popover disables its trigger the same way (Notes-style: a menu
/// whose every row is greyed out costs a click to learn nothing).
pub fn set_format_enabled(window: &Window, enabled: bool) {
    let label = window.label().to_string();
    let _ = window.run_on_main_thread(move || {
        let Some(buttons) = buttons_for(&label) else {
            return;
        };
        unsafe {
            let format: &NSButton = &*(buttons.format as *const NSButton);
            format.setEnabled(enabled);
        }
    });
}

/// FE-reported editor display mode -> the "more" menu's checkmark state.
pub fn set_mode(window: &Window, markdown: bool) {
    let mut guard = MODES.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(window.label().to_string(), markdown);
}

/// Drop the pointer-map entries when a window dies.
pub fn forget(label: &str) {
    buttons_map(|m| {
        m.remove(label);
    });
    if let Some(m) = MODES.lock().unwrap().as_mut() {
        m.remove(label);
    }
}

/// Resolve which Tauri window owns the clicked accessory view.
fn window_for_sender(sender: *mut AnyObject) -> Option<tauri::WebviewWindow> {
    let handle = HANDLE.get()?;
    if sender.is_null() {
        return None;
    }
    let sender_window_ptr = unsafe {
        let view: &NSView = &*(sender as *const NSView);
        Retained::as_ptr(&view.window()?) as *mut c_void
    };
    handle
        .webview_windows()
        .into_values()
        .find(|win| win.ns_window().is_ok_and(|ptr| ptr == sender_window_ptr))
}

/// Hand key focus back to the editor webview. Every titlebar action operates
/// on the editor's cursor, and interacting with native chrome (a click that
/// landed on the titlebar, a popup menu run) can leave the window's first
/// responder outside the webview — keystrokes then bypass the editor even
/// though the page's DOM focus (and the model cursor) survived. Restoring
/// the responder before emitting makes a titlebar action equivalent to
/// "click back into the document, then act".
///
/// The webview is the handle cached at install time (WinButtons.webview,
/// obtained from wry through tauri's with_webview). Never rediscover it by
/// walking the content view tree: the walk's retain/release traffic over
/// wry's private views over-released WryWebViewParent in release builds —
/// the third titlebar click deallocated it mid-hierarchy and the AppKit
/// NSView assertion aborted the whole app (NSInternalInconsistencyException
/// unwinding into tao's non-unwind sendEvent boundary).
fn restore_webview_focus(win: &tauri::WebviewWindow) {
    let Some(buttons) = buttons_for(win.label()) else {
        return;
    };
    if buttons.webview == 0 {
        return;
    }
    let Ok(ns_window_ptr) = win.ns_window() else {
        return;
    };
    unsafe {
        let ns_window: &objc2_app_kit::NSWindow =
            &*(ns_window_ptr as *const objc2_app_kit::NSWindow);
        let webview: &NSView = &*(buttons.webview as *const NSView);
        ns_window.makeFirstResponder(Some(webview));
    }
}

fn emit_for_sender(sender: *mut AnyObject, event: &str) {
    if let Some(win) = window_for_sender(sender) {
        restore_webview_focus(&win);
        let _ = win.emit_to(win.label(), event, ());
    }
}

/// Emit to the window whose popup menu produced the action (menu items have
/// no window to resolve from — see MENU_WINDOW).
fn emit_to_menu_window(event: &str) {
    emit_to_menu_window_payload(event, ());
}

fn emit_to_menu_window_payload<S: serde::Serialize + Clone>(event: &str, payload: S) {
    let Some(handle) = HANDLE.get() else {
        return;
    };
    let label = MENU_WINDOW.lock().unwrap().clone();
    let Some(label) = label else {
        return;
    };
    if let Some(win) = handle.get_webview_window(&label) {
        // Menu items act on the editor too — hand focus back first (see
        // restore_webview_focus).
        restore_webview_focus(&win);
        let _ = win.emit_to(win.label(), event, payload);
    }
}

extern "C-unwind" fn share_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    emit_for_sender(sender, "titlebar-share");
}

extern "C-unwind" fn manage_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    emit_for_sender(sender, "titlebar-versioning");
}

extern "C-unwind" fn insert_table_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    emit_for_sender(sender, "titlebar-insert-table");
}

extern "C-unwind" fn insert_checklist_clicked(
    _this: *mut AnyObject,
    _sel: Sel,
    sender: *mut AnyObject,
) {
    emit_for_sender(sender, "titlebar-insert-checklist");
}

/// "More" button -> native popup menu, mirroring the web top bar's "…"
/// dropdown. Built fresh on every click so the mode checkmark is current.
extern "C-unwind" fn more_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    use objc2_app_kit::{
        NSApplication, NSControlStateValueOn, NSEventModifierFlags, NSMenu, NSMenuItem,
    };

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(win) = window_for_sender(sender) else {
        return;
    };
    let label = win.label().to_string();
    let markdown = {
        let guard = MODES.lock().unwrap();
        guard
            .as_ref()
            .and_then(|m| m.get(&label).copied())
            .unwrap_or(false)
    };
    *MENU_WINDOW.lock().unwrap() = Some(label);

    let locale = menu_i18n::system_locale();

    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        let delegate = app.delegate();
        let target = delegate
            .as_ref()
            .map(|d| Retained::as_ptr(d) as *const AnyObject);

        let menu = NSMenu::new(mtm);

        // Display-mode toggle. The checkmark IS the current state (on =
        // markdown, off = rich) — same semantics as the web menu's switch.
        // The key equivalent is display-only (popup menus don't register
        // global shortcuts); the keystroke itself is handled by the
        // frontend's ModeController.
        let mode_item = NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(&menu_i18n::t(locale, "editor.modeMarkdown")),
            Some(sel!(domdTitlebarToggleMode:)),
            &NSString::from_str("/"),
        );
        mode_item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
        if let Some(t) = target {
            mode_item.setTarget(Some(&*t));
        }
        if markdown {
            mode_item.setState(NSControlStateValueOn);
        }
        menu.addItem(&mode_item);

        menu.addItem(&NSMenuItem::separatorItem(mtm));

        // "Export PDF…" — the ellipsis marks the follow-up save dialog.
        let pdf_item = NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(&format!("{}…", menu_i18n::t(locale, "editor.exportPdf"))),
            Some(sel!(domdTitlebarExportPdf:)),
            &NSString::from_str(""),
        );
        if let Some(t) = target {
            pdf_item.setTarget(Some(&*t));
        }
        menu.addItem(&pdf_item);

        // Pop just below the button. The accessory view is non-flipped
        // (y grows upward), so the button's bottom edge is y = 0.
        let button: &NSView = &*(sender as *const NSView);
        menu.popUpMenuPositioningItem_atLocation_inView(
            None,
            NSPoint::new(0.0, -4.0),
            Some(button),
        );
    }
}

extern "C-unwind" fn toggle_mode_clicked(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) {
    emit_to_menu_window("titlebar-toggle-mode");
}

extern "C-unwind" fn export_pdf_clicked(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) {
    emit_to_menu_window("titlebar-export-pdf");
}

extern "C-unwind" fn ai_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    emit_for_sender(sender, "titlebar-ai");
}

extern "C-unwind" fn toc_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    emit_for_sender(sender, "titlebar-toc");
}

/// "Aa" button: ask the frontend for the menu. It answers with the
/// `show_format_menu` command once it has snapshotted the format state (the
/// block half costs a toMarkdown(), which only the webview can run) — the
/// pull keeps the menu's enabled/active marks exactly as fresh as the web
/// popover's open-time refresh.
extern "C-unwind" fn format_menu_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    let Some(win) = window_for_sender(sender) else {
        return;
    };
    *MENU_WINDOW.lock().unwrap() = Some(win.label().to_string());
    let _ = win.emit_to(win.label(), "titlebar-format-request", ());
}

extern "C-unwind" fn format_item_clicked(_this: *mut AnyObject, _sel: Sel, sender: *mut AnyObject) {
    if sender.is_null() {
        return;
    }
    let id = unsafe {
        let item: &objc2_app_kit::NSMenuItem = &*(sender as *const objc2_app_kit::NSMenuItem);
        let Some(obj) = item.representedObject() else {
            return;
        };
        let Ok(s) = obj.downcast::<NSString>() else {
            return;
        };
        s.to_string()
    };
    emit_to_menu_window_payload("titlebar-format-command", id);
}

/// One entry of the frontend-described format menu. The frontend owns
/// labels (runtime i18n), ids, shortcut spellings and state; this side only
/// renders. `key`/`shift`/`alt` describe the ⌘-based key equivalent for
/// DISPLAY — popup menus don't register global shortcuts, the real keys are
/// bound by the frontend's keyboard layer.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FormatMenuEntry {
    #[serde(rename_all = "camelCase")]
    Section { label: String },
    Separator,
    #[serde(rename_all = "camelCase")]
    Item {
        id: String,
        label: String,
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        active: bool,
        #[serde(default)]
        key: Option<String>,
        #[serde(default)]
        shift: bool,
        #[serde(default)]
        alt: bool,
    },
}

fn default_true() -> bool {
    true
}

/// Render the frontend-described menu as a native NSMenu popped under the
/// window's "Aa" button. Called by the `show_format_menu` command.
pub fn show_format_menu(window: &tauri::WebviewWindow, entries: Vec<FormatMenuEntry>) {
    let label = window.label().to_string();
    let _ = window.run_on_main_thread(move || {
        show_format_menu_on_main(&label, entries);
    });
}

fn show_format_menu_on_main(label: &str, entries: Vec<FormatMenuEntry>) {
    use objc2::{msg_send, ClassType};
    use objc2_app_kit::{
        NSApplication, NSControlStateValueOn, NSEventModifierFlags, NSMenu, NSMenuItem,
    };

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(buttons) = buttons_for(label) else {
        return;
    };
    // Re-anchor the action target: the request/response round-trip could in
    // principle interleave with another window's popup.
    *MENU_WINDOW.lock().unwrap() = Some(label.to_string());

    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        let delegate = app.delegate();
        let target = delegate
            .as_ref()
            .map(|d| Retained::as_ptr(d) as *const AnyObject);

        let menu = NSMenu::new(mtm);
        // We drive item enabling from the frontend snapshot; AppKit's
        // auto-enabling would re-derive it from responder chains and win.
        menu.setAutoenablesItems(false);

        // sectionHeaderWithTitle: is macOS 14+; fall back to a disabled item.
        let supports_sections: bool = msg_send![
            NSMenuItem::class(),
            respondsToSelector: sel!(sectionHeaderWithTitle:)
        ];

        for entry in entries {
            match entry {
                FormatMenuEntry::Section { label } => {
                    let title = NSString::from_str(&label);
                    if supports_sections {
                        menu.addItem(&NSMenuItem::sectionHeaderWithTitle(&title, mtm));
                    } else {
                        let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                            NSMenuItem::alloc(mtm),
                            &title,
                            None,
                            &NSString::from_str(""),
                        );
                        item.setEnabled(false);
                        menu.addItem(&item);
                    }
                }
                FormatMenuEntry::Separator => {
                    menu.addItem(&NSMenuItem::separatorItem(mtm));
                }
                FormatMenuEntry::Item {
                    id,
                    label,
                    enabled,
                    active,
                    key,
                    shift,
                    alt,
                } => {
                    let key_equiv = key.unwrap_or_default();
                    let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm),
                        &NSString::from_str(&label),
                        Some(sel!(domdTitlebarFormatItem:)),
                        &NSString::from_str(&key_equiv),
                    );
                    if !key_equiv.is_empty() {
                        let mut mask = NSEventModifierFlags::Command;
                        if shift {
                            mask |= NSEventModifierFlags::Shift;
                        }
                        if alt {
                            mask |= NSEventModifierFlags::Option;
                        }
                        item.setKeyEquivalentModifierMask(mask);
                    }
                    if let Some(t) = target {
                        item.setTarget(Some(&*t));
                    }
                    item.setEnabled(enabled);
                    if active {
                        item.setState(NSControlStateValueOn);
                    }
                    item.setRepresentedObject(Some(&NSString::from_str(&id)));
                    menu.addItem(&item);
                }
            }
        }

        let button: &NSView = &*(buttons.format as *const NSView);
        menu.popUpMenuPositioningItem_atLocation_inView(
            None,
            NSPoint::new(0.0, -4.0),
            Some(button),
        );
    }
}
