//! NSDocument subclass that lets us reuse AppKit's "save changes before
//! closing?" sheet — the one with the Delete button — for Tauri-owned
//! untitled windows. NSDocument is the only public API surface that produces
//! that exact UI; the Delete button is added by NSDocument itself when the
//! document is untitled + edited at close time, and is not configurable via
//! NSSavePanel.
//!
//! Design notes:
//! - The doc is a sidecar — it does NOT own the Tauri NSWindow. We only
//!   override `windowForSheet` so save sheets attach to the right window.
//! - Lifetime: created lazily on close request, stored in `WindowDocs` until
//!   the close flow ends, then dropped (which releases the underlying ObjC
//!   object).
//! - All ObjC interaction happens on the main thread; the only cross-thread
//!   thing is the `Drop` impl on `WindowDoc`, which is fine because
//!   `release` is atomic.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicPtr, Ordering};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{
    define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly, Message,
};
use objc2_app_kit::{NSDocument, NSDocumentChangeType, NSSaveOperationType, NSWindow};
use objc2_foundation::{NSData, NSError, NSObjectProtocol, NSString};

pub struct UntitledDocIvars {
    /// Pointer to the Tauri-owned NSWindow used as the sheet parent. Stored
    /// as a non-owning raw pointer because Tauri owns the retain.
    pub ns_window: AtomicPtr<NSWindow>,
    /// Suggested name shown in the save sheet's Save As field.
    pub display_name: RefCell<String>,
    /// Markdown bytes returned by `dataOfType:error:` when AppKit asks us
    /// for the contents to write.
    pub pending_content: RefCell<Vec<u8>>,
    /// Fired after `canCloseDocument` resolves. Args: (should_close,
    /// chosen_file_path).
    pub close_callback: RefCell<Option<Box<dyn FnOnce(bool, Option<String>)>>>,
}

define_class!(
    #[unsafe(super(NSDocument))]
    #[thread_kind = MainThreadOnly]
    #[name = "DOMDUntitledDoc"]
    #[ivars = UntitledDocIvars]
    pub struct UntitledDoc;

    unsafe impl NSObjectProtocol for UntitledDoc {}

    impl UntitledDoc {
        // Disable autosave + versions: Tauri's app already handles its own
        // dirty tracking and we don't want NSDocument writing to backup
        // locations behind our back.
        #[unsafe(method(autosavesInPlace))]
        fn autosaves_in_place() -> bool {
            false
        }

        #[unsafe(method(preservesVersions))]
        fn preserves_versions() -> bool {
            false
        }

        // Pin the file extension to .md regardless of how the panel asks.
        #[unsafe(method_id(fileNameExtensionForType:saveOperation:))]
        fn file_name_extension(
            &self,
            _type_name: &NSString,
            _op: NSSaveOperationType,
        ) -> Option<Retained<NSString>> {
            Some(NSString::from_str("md"))
        }

        // Populate the panel's "Save As" field with the suggested name.
        #[unsafe(method_id(displayName))]
        fn display_name(&self) -> Retained<NSString> {
            NSString::from_str(&self.ivars().display_name.borrow())
        }

        // AppKit calls this to get the bytes to write. We pre-stage the
        // markdown in `pending_content` before kicking off the close flow.
        #[unsafe(method_id(dataOfType:error:))]
        fn data_of_type(
            &self,
            _type_name: &NSString,
            _err: Option<&mut *mut NSError>,
        ) -> Option<Retained<NSData>> {
            Some(NSData::with_bytes(&self.ivars().pending_content.borrow()))
        }

        // Abstract on the superclass — never called by us (we never load
        // through NSDocument), but must be implemented.
        #[unsafe(method(readFromData:ofType:error:))]
        fn read_from_data(
            &self,
            _data: &NSData,
            _type_name: &NSString,
            _err: Option<&mut *mut NSError>,
        ) -> bool {
            true
        }

        // Attach the save sheet to the Tauri NSWindow.
        #[unsafe(method_id(windowForSheet))]
        fn window_for_sheet(&self) -> Option<Retained<NSWindow>> {
            let ptr = self.ivars().ns_window.load(Ordering::Acquire);
            // SAFETY: ptr (if non-null) is a Tauri-retained NSWindow. We
            // bump retain for the caller; balanced by their Retained drop.
            unsafe { ptr.as_ref().map(|w| w.retain()) }
        }

        // canCloseDocument's delegate selector. AppKit calls this once the
        // user picks Save / Don't Save / Cancel.
        #[unsafe(method(document:shouldClose:contextInfo:))]
        fn document_should_close(
            &self,
            _doc: *mut AnyObject,
            should_close: bool,
            _ctx: *mut c_void,
        ) {
            let saved_path = self
                .fileURL()
                .and_then(|u| u.path().map(|s| s.to_string()));
            let cb = self.ivars().close_callback.borrow_mut().take();
            if let Some(cb) = cb {
                cb(should_close, saved_path);
            }
        }
    }
);

impl UntitledDoc {
    pub fn new(mtm: MainThreadMarker, display_name: String) -> Retained<Self> {
        let ivars = UntitledDocIvars {
            ns_window: AtomicPtr::new(std::ptr::null_mut()),
            display_name: RefCell::new(display_name),
            pending_content: RefCell::new(Vec::new()),
            close_callback: RefCell::new(None),
        };
        let this = Self::alloc(mtm).set_ivars(ivars);
        let doc: Retained<Self> = unsafe { msg_send![super(this), init] };
        // NSDocument needs a fileType identifier for the save flow even
        // though we override `fileNameExtensionForType:`.
        doc.setFileType(Some(&NSString::from_str("Markdown")));
        doc
    }

    pub fn set_ns_window(&self, win: &NSWindow) {
        self.ivars()
            .ns_window
            .store(win as *const NSWindow as *mut NSWindow, Ordering::Release);
    }

    pub fn set_display_name(&self, name: &str) {
        *self.ivars().display_name.borrow_mut() = name.to_string();
    }

    /// Kicks off NSDocument's `canCloseDocument` flow. `callback` fires on
    /// the main thread when the user picks an outcome.
    pub fn begin_close(
        &self,
        content: Vec<u8>,
        callback: Box<dyn FnOnce(bool, Option<String>)>,
    ) {
        *self.ivars().pending_content.borrow_mut() = content;
        *self.ivars().close_callback.borrow_mut() = Some(callback);

        // Mark edited so canCloseDocument actually pops the sheet instead
        // of silently returning shouldClose=true.
        self.updateChangeCount(NSDocumentChangeType::ChangeDone);

        let self_obj: &AnyObject = self.as_ref();
        unsafe {
            self.canCloseDocumentWithDelegate_shouldCloseSelector_contextInfo(
                self_obj,
                Some(sel!(document:shouldClose:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }
}

/// Send-safe wrapper around a `Retained<UntitledDoc>`. The wrapped doc must
/// be touched only on the main thread; `Drop` calls `release` which is
/// atomic and safe to invoke from any thread.
pub struct WindowDoc {
    ptr: NonNull<UntitledDoc>,
}

// SAFETY: Doc instance methods must be called on the main thread (enforced
// by callers). `release` (Drop) is thread-safe per Apple's runtime.
unsafe impl Send for WindowDoc {}

impl WindowDoc {
    pub fn new(doc: Retained<UntitledDoc>) -> Self {
        let raw = Retained::into_raw(doc);
        Self {
            // SAFETY: `Retained::into_raw` never yields null.
            ptr: unsafe { NonNull::new_unchecked(raw) },
        }
    }

    /// Get a reference to the underlying doc.
    ///
    /// # Safety
    /// Must be called on the main thread.
    pub unsafe fn as_ref_on_main(&self) -> &UntitledDoc {
        unsafe { self.ptr.as_ref() }
    }
}

impl Drop for WindowDoc {
    fn drop(&mut self) {
        // SAFETY: We took ownership in `new`; this balances that retain.
        unsafe {
            let _ = Retained::from_raw(self.ptr.as_ptr());
        }
    }
}
