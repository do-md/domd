//! Native "Export PDF" for the desktop build (macOS).
//!
//! The web build prints a cloned DOM through a hidden iframe
//! (features/editor/lib/export-pdf.ts). That path is dead inside WKWebView,
//! which ignores JS `window.print()` — so the desktop build lets the OS do
//! the work instead: WKWebView's `printOperationWithPrintInfo:` paginates
//! the live DOM (the desktop window renders no web chrome, and the
//! `@media print` rules in app/globals.css strip the editing surface), and
//! the job is spooled straight to a PDF file. No print panel, no WebKit
//! header/footer, real selectable vector output — strictly better than the
//! web fallback, which can only default the header/footer off.

use std::ffi::c_void;

use objc2_app_kit::{
    NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob,
    NSPrintingPaginationMode,
};
use objc2_foundation::{NSNumber, NSString, NSURL};
use objc2_web_kit::WKWebView;

// Page margins in points: ~15mm top/bottom, ~14mm left/right — the same page
// geometry the web export applies as content padding, so both paths produce
// the same-looking page.
const MARGIN_TOP_BOTTOM: f64 = 42.0;
const MARGIN_LEFT_RIGHT: f64 = 40.0;

/// Print the webview's current DOM into a PDF at `path`.
///
/// Must run on the main thread — call it from `with_webview`, whose closure
/// Tauri dispatches there.
///
/// # Safety
/// `webview_ptr` must be a valid `WKWebView` pointer (the macOS value of
/// `PlatformWebview::inner`).
pub unsafe fn print_to_pdf(webview_ptr: *mut c_void, path: &str) -> Result<(), String> {
    let webview: &WKWebView = &*webview_ptr.cast::<WKWebView>();

    // A fresh NSPrintInfo, NOT sharedPrintInfo — exporting must not mutate
    // the app-global print settings.
    let info = NSPrintInfo::new();
    info.setTopMargin(MARGIN_TOP_BOTTOM);
    info.setBottomMargin(MARGIN_TOP_BOTTOM);
    info.setLeftMargin(MARGIN_LEFT_RIGHT);
    info.setRightMargin(MARGIN_LEFT_RIGHT);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    // Fit-to-width horizontally, flow onto as many pages as needed vertically.
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    // Spool to a file instead of a printer.
    info.setJobDisposition(NSPrintSaveJob);

    let dict = info.dictionary();
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    dict.insert(NSPrintJobSavingURL, &url);
    // Suppress WebKit's default page header/footer (title, URL, page number).
    let off = NSNumber::numberWithBool(false);
    dict.insert(NSPrintHeaderAndFooter, &off);

    let op = webview.printOperationWithPrintInfo(&info);
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    if op.runOperation() {
        Ok(())
    } else {
        Err("print operation failed".into())
    }
}
