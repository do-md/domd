//! Native macOS titlebar buttons (insert entries + collaboration).
//!
//! Every editor window gets an NSTitlebarAccessoryViewController pinned to
//! the trailing edge of the title bar with four SF-symbol buttons:
//!
//!  - table     (tablecells)             -> emits `titlebar-insert-table`
//!  - checklist (checklist)              -> emits `titlebar-insert-checklist`
//!  - manage    (clock.arrow.circlepath) -> emits `titlebar-versioning`,
//!    hidden until a collaboration session is active
//!  - share     (person.2)               -> emits `titlebar-share`
//!
//! The two insert buttons mirror the web top bar's InsertToolbar (which the
//! desktop app doesn't render — the native titlebar IS its top bar). The
//! frontend handles the emitted events by calling the editor store
//! (see features/editor/components/editor-app.tsx TitlebarInsertBridge).
//!
//! Click handling follows the dock-menu pattern: action selectors are added
//! to the existing app delegate class at runtime, and the handler resolves
//! which Tauri window owns the clicked button by comparing NSWindow pointers.
//! The webview mirrors session state back via the `set_collab_state` command
//! so the buttons can reflect it (accent tint + manage visibility).

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSButton, NSColor, NSImage, NSLayoutAttribute, NSTitlebarAccessoryViewController, NSView,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::menu_i18n;

static HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// window label -> (share button ptr, manage button ptr). The accessory view
/// retains the buttons; raw pointers here are for later state updates.
static BUTTONS: Mutex<Option<HashMap<String, (usize, usize)>>> = Mutex::new(None);

fn buttons_map(f: impl FnOnce(&mut HashMap<String, (usize, usize)>)) {
    let mut guard = BUTTONS.lock().unwrap();
    f(guard.get_or_insert_with(HashMap::new));
}

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

/// Register the click selectors on the app delegate. Call once at setup,
/// after the delegate exists (same timing as dock_menu::setup).
pub fn setup(handle: &AppHandle) {
    use objc2_app_kit::NSApplication;

    HANDLE.set(handle.clone()).ok();

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

fn symbol_button(
    mtm: MainThreadMarker,
    symbol: &str,
    fallback_title: &str,
    action: Sel,
    frame: NSRect,
    tooltip: &str,
) -> Retained<NSButton> {
    use objc2_app_kit::NSApplication;

    let app = NSApplication::sharedApplication(mtm);
    let delegate = app.delegate();
    let target = delegate
        .as_ref()
        .map(|d| Retained::as_ptr(d) as *const AnyObject);

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
        button
    };
    button
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

        // Layout (trailing edge, left→right): insert group [table, checklist]
        // then collaboration group [manage?, share]. Initial state is the
        // COLLAPSED (no session) layout: manage hidden and taking no slot.
        let container = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), container_size(3)),
        );

        let table = symbol_button(
            mtm,
            "tablecells",
            "T",
            sel!(domdTitlebarInsertTable:),
            slot_rect(0),
            &menu_i18n::t(locale, "editor.insert.table"),
        );

        let checklist = symbol_button(
            mtm,
            "checklist",
            "C",
            sel!(domdTitlebarInsertChecklist:),
            slot_rect(1),
            &menu_i18n::t(locale, "editor.insert.checklist"),
        );

        let manage = symbol_button(
            mtm,
            "clock.arrow.circlepath",
            "H",
            sel!(domdTitlebarManage:),
            slot_rect(2),
            &menu_i18n::t(locale, "versioning.title"),
        );
        manage.setHidden(true);

        let share = symbol_button(
            mtm,
            "person.2",
            "S",
            sel!(domdTitlebarShare:),
            slot_rect(2),
            &menu_i18n::t(locale, "collab.share"),
        );

        container.addSubview(&table);
        container.addSubview(&checklist);
        container.addSubview(&manage);
        container.addSubview(&share);

        let vc = NSTitlebarAccessoryViewController::new(mtm);
        vc.setView(&container);
        vc.setLayoutAttribute(NSLayoutAttribute::Trailing);
        ns_window.addTitlebarAccessoryViewController(&vc);

        buttons_map(|m| {
            m.insert(
                label,
                (
                    Retained::into_raw(share) as usize,
                    Retained::into_raw(manage) as usize,
                ),
            );
        });
        // The accessory VC must outlive this scope; the window does not take
        // ownership of our Rust handle. Leak it — one per window, freed with
        // the process.
        let _ = Retained::into_raw(vc);
    }
}

/// Frontend-reported session state -> button appearance.
pub fn set_state(window: &Window, active: bool, peers: u32) {
    let label = window.label().to_string();
    let locale = menu_i18n::system_locale();
    let share_tip = if active {
        format!("{} · {}", menu_i18n::t(locale, "collab.sharingBadge"), peers + 1)
    } else {
        menu_i18n::t(locale, "collab.share")
    };
    let _ = window.run_on_main_thread(move || {
        let ptrs = {
            let guard = BUTTONS.lock().unwrap();
            guard.as_ref().and_then(|m| m.get(&label).copied())
        };
        let Some((share_ptr, manage_ptr)) = ptrs else {
            return;
        };
        unsafe {
            let share: &NSButton = &*(share_ptr as *const NSButton);
            let manage: &NSButton = &*(manage_ptr as *const NSButton);
            // Reflow, not just hide: with no session the manage slot is
            // removed entirely (share slides left, container narrows) so the
            // titlebar never shows a dead gap.
            manage.setHidden(!active);
            let share_slot = if active { 3 } else { 2 };
            share.setFrame(slot_rect(share_slot));
            if let Some(container) = share.superview() {
                container.setFrameSize(container_size(share_slot + 1));
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

/// Drop the pointer-map entry when a window dies.
pub fn forget(label: &str) {
    buttons_map(|m| {
        m.remove(label);
    });
}

fn emit_for_sender(sender: *mut AnyObject, event: &str) {
    let Some(handle) = HANDLE.get() else {
        return;
    };
    if sender.is_null() {
        return;
    }
    let sender_window_ptr = unsafe {
        let view: &NSView = &*(sender as *const NSView);
        match view.window() {
            Some(w) => Retained::as_ptr(&w) as *mut c_void,
            None => return,
        }
    };
    for win in handle.webview_windows().values() {
        if let Ok(ptr) = win.ns_window() {
            if ptr == sender_window_ptr {
                let _ = win.emit_to(win.label(), event, ());
                return;
            }
        }
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
