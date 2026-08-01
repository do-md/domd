//! Native macOS titlebar collaboration buttons.
//!
//! Every editor window gets an NSTitlebarAccessoryViewController pinned to
//! the trailing edge of the title bar with two SF-symbol buttons:
//!
//!  - share  (person.2)                 -> emits `titlebar-share`
//!  - manage (clock.arrow.circlepath)   -> emits `titlebar-versioning`,
//!    hidden until a collaboration session is active
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

        let container = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(66.0, 26.0)),
        );

        let manage = symbol_button(
            mtm,
            "clock.arrow.circlepath",
            "H",
            sel!(domdTitlebarManage:),
            NSRect::new(NSPoint::new(4.0, 3.0), NSSize::new(28.0, 20.0)),
            &menu_i18n::t(locale, "versioning.title"),
        );
        manage.setHidden(true);

        let share = symbol_button(
            mtm,
            "person.2",
            "S",
            sel!(domdTitlebarShare:),
            NSRect::new(NSPoint::new(34.0, 3.0), NSSize::new(28.0, 20.0)),
            &menu_i18n::t(locale, "collab.share"),
        );

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
            manage.setHidden(!active);
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
