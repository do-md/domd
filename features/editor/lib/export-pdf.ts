// Web-only "Export PDF".
//
// The editor already renders a faithful, vector, WYSIWYG DOM (`data-domd-root`)
// with Prism-highlighted code, tables, images and task lists. The browser's own
// print engine turns that into a paginated, selectable, vector PDF for free — so
// export is just: clone the rendered DOM into an isolated iframe, apply a print
// stylesheet, and let the user "Save as PDF". No canvas, no rasterization, no
// second render engine to keep in sync with the editor.

// Print-time overrides layered on top of the editor's own stylesheets.
const PRINT_CSS = `
/* margin:0 suppresses the browser's default print header/footer (URL, date,
   page number) — with no page-margin box, Chrome/Edge have nowhere to draw
   them, so they're off by default. The visual page margins are re-applied as
   padding on the content wrapper below. (The user can still re-enable
   headers/footers in the print dialog; this only sets the default.) */
@page { margin: 0; }
html, body { background: #fff !important; height: auto !important; }
body { margin: 0; }
.domd-pdf-page {
    box-sizing: border-box;
    width: 100%;
    margin: 0 auto;
    padding: 16mm 14mm;
    color: var(--color-base-content, #141414);
}
[data-domd-root] { min-height: 0 !important; }
/* Keep code-block backgrounds, highlight marks and syntax colors in the PDF. */
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* Markdown syntax markers only surface on the active editing line; force them
   off so the PDF reads as a rendered document, not raw markdown. */
.DOMD-MdSymbol { display: none !important; }
/* Don't slice atomic blocks across page boundaries where they fit on one page. */
pre, blockquote, table, img, figure,
.DOMD-Pre, .DOMD-Table, .DOMD-Blockquote { break-inside: avoid; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; }
`;

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Reproduce the parent document's stylesheets inside the print iframe so the
// clone is styled identically. Covers both Next dev (inline <style>, Turbopack)
// and static export (<link> to /_next/static/css).
function collectHeadStyles(): string {
    const nodes = document.head.querySelectorAll(
        'style, link[rel="stylesheet"]',
    );
    const parts: string[] = [];
    for (const node of Array.from(nodes)) {
        if (node instanceof HTMLLinkElement) {
            if (node.href) {
                parts.push(
                    `<link rel="stylesheet" href="${escapeAttr(node.href)}">`,
                );
            }
        } else if (node instanceof HTMLStyleElement) {
            parts.push(`<style>${node.textContent ?? ""}</style>`);
        }
    }
    return parts.join("\n");
}

// Strip editing chrome from the cloned tree so it prints as a static document.
function cleanClone(el: HTMLElement): void {
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    el.removeAttribute("tabindex");
    el.querySelectorAll("[contenteditable]").forEach((n) =>
        n.removeAttribute("contenteditable"),
    );
    // Drop the CustomCursor portal node (teal caret overlay) — it lives inside
    // the editor root and is identified by its distinctive `contain: strict`.
    el.querySelectorAll(
        '[style*="contain: strict"], [style*="contain:strict"]',
    ).forEach((n) => n.remove());
}

// Wait for the reproduced stylesheets to load. This is CRITICAL: the app's real
// styling lives in async <link> chunks (Tailwind/DaisyUI + the editor's own CSS),
// and a fresh iframe fetches them anew. Print before they arrive and the PDF
// captures the unstyled, UA-default DOM (no theme, no backgrounds, no fonts).
// A stylesheet is ready once its `.sheet` is populated; otherwise wait for load.
function waitForStyles(doc: Document): Promise<void> {
    const links = Array.from(
        doc.querySelectorAll('link[rel="stylesheet"]'),
    ) as HTMLLinkElement[];
    const waits = links.map((link) =>
        link.sheet
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                  link.addEventListener("load", () => resolve(), {
                      once: true,
                  });
                  link.addEventListener("error", () => resolve(), {
                      once: true,
                  });
              }),
    );
    const ready = Promise.all(waits).then(() => undefined);
    const cap = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    return Promise.race([ready, cap]);
}

// Yield two frames so a style/layout recalc flushes before we hand off to print.
function nextFrame(win: Window): Promise<void> {
    return new Promise((resolve) =>
        win.requestAnimationFrame(() =>
            win.requestAnimationFrame(() => resolve()),
        ),
    );
}

// Wait for images and fonts so nothing prints half-loaded, with a hard cap so a
// stuck asset can never block the print dialog.
function waitForAssets(doc: Document): Promise<void> {
    const imgWaits = Array.from(doc.images).map((img) =>
        img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                  img.addEventListener("load", () => resolve(), { once: true });
                  img.addEventListener("error", () => resolve(), {
                      once: true,
                  });
              }),
    );
    const fontWait = doc.fonts?.ready
        ? doc.fonts.ready.then(() => undefined).catch(() => undefined)
        : Promise.resolve();
    const ready = Promise.all([...imgWaits, fontWait]).then(() => undefined);
    const cap = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    return Promise.race([ready, cap]);
}

/**
 * Open the browser's print-to-PDF flow for the current document.
 *
 * @param container The wrapper holding the editor (the `[data-domd-root]` inside
 *                  it is what gets exported).
 * @param title     Used as the print document title → the default PDF filename.
 */
export function exportToPdf(container: HTMLElement | null, title: string): void {
    if (typeof window === "undefined") return;
    const root =
        (container?.querySelector("[data-domd-root]") as HTMLElement | null) ??
        container;
    if (!root) return;

    const clone = root.cloneNode(true) as HTMLElement;
    cleanClone(clone);

    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    Object.assign(iframe.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        width: "0",
        height: "0",
        border: "0",
        visibility: "hidden",
    });
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) {
        iframe.remove();
        return;
    }

    const safeTitle = (title || "document").trim() || "document";
    doc.open();
    doc.write(
        `<!doctype html><html data-theme="light" style="color-scheme: light"><head>` +
            `<meta charset="utf-8">` +
            `<base href="${escapeAttr(window.location.href)}">` +
            `<title>${escapeHtml(safeTitle)}</title>` +
            collectHeadStyles() +
            `<style>${PRINT_CSS}</style>` +
            `</head><body><div class="domd-pdf-page">${clone.outerHTML}</div></body></html>`,
    );
    doc.close();

    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        // Defer removal so the print preview keeps its source document.
        setTimeout(() => iframe.remove(), 500);
    };

    const triggerPrint = async () => {
        // Stylesheets first — printing before they load yields an unstyled PDF.
        await waitForStyles(doc);
        await waitForAssets(doc);
        await nextFrame(win);
        win.addEventListener("afterprint", cleanup, { once: true });
        // Fallback: some engines never fire afterprint (or the user cancels).
        setTimeout(cleanup, 60000);
        win.focus();
        win.print();
    };

    if (doc.readyState === "complete") {
        void triggerPrint();
    } else {
        iframe.addEventListener("load", () => void triggerPrint(), {
            once: true,
        });
    }
}
