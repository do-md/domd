// Desktop-only "Export PDF".
//
// The web build's iframe + `window.print()` flow (export-pdf.ts) is dead
// inside WKWebView, which ignores JS print calls. The desktop path instead
// asks the OS to print the live DOM: pick a destination with the native save
// dialog, then invoke the `export_pdf` command (src-tauri/src/print.rs),
// which runs WKWebView's print operation straight to the chosen file — no
// print panel, no WebKit header/footer. The `@media print` rules in
// app/globals.css strip the editing chrome and unlock the scroll container
// so the document paginates as a plain flow.

import { tauriCore, tauriDialog } from "@/common/lib/tauri";

/**
 * Run the full desktop export flow. Resolves once the PDF is written, or
 * immediately when the user cancels the save dialog. Throws on print
 * failure — callers decide how to surface it.
 */
export async function exportToPdfDesktop(title: string): Promise<void> {
    const safeTitle = (title || "document").trim() || "document";
    const { save } = await tauriDialog();
    const path = await save({
        defaultPath: `${safeTitle}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return;
    const { invoke } = await tauriCore();
    await invoke("export_pdf", { path });
}
