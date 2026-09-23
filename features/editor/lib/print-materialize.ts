// Pre-print DOM materialization seam.
//
// Both PDF export flows print the LIVE editor DOM (web: clone into an iframe,
// desktop: WKWebView printOperation over the page itself). Under DOM
// virtualization only the render window is mounted, so an export would
// truncate to roughly one viewport. The editor registers a materializer
// (backed by @do-md/virtual's materializeForPrint: force-full render, resolve
// after commit); export flows acquire the full DOM around their capture and
// release it after. With no registration (virtualization off / not wired)
// acquire resolves immediately — zero behavior change.
//
// A module-level registry (not React context) on purpose: the desktop trigger
// lives in the titlebar bridge OUTSIDE the virtual store's provider subtree.

type Materializer = () => Promise<() => void>;

let current: Materializer | null = null;

/** Register the active editor's materializer; returns the unregister. */
export const registerPrintMaterializer = (fn: Materializer): (() => void) => {
    current = fn;
    return () => {
        if (current === fn) current = null;
    };
};

/** Force the full document into the DOM. Resolves once the render committed
 *  (or after the materializer's own deadline — frames can stop arriving);
 *  the returned release restores the virtualized window (idempotent).
 *  ALWAYS call the release from a `finally`: a throwing export would
 *  otherwise leave every block mounted for the rest of the session. */
export const acquireFullDom = async (): Promise<() => void> => {
    if (!current) return () => {};
    try {
        return await current();
    } catch {
        // A materializer that fails must not block the export.
        return () => {};
    }
};
