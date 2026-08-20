import { isViewOnlyDom } from "./isViewOnlyDom";

/**
 * The DOM→model text read: `textContent` minus view-only subtrees. EVERY
 * kernel read of a render element's text for reparse purposes must go through
 * this (never raw `.textContent`), or decoration glyphs get read back as
 * typed input and duplicate on every parse round-trip.
 * Accepts null/undefined for call-site ergonomics (returns "").
 */
export const getVisibleDomText = (
    root: Node | null | undefined,
): string => {
    if (!root) return "";
    let out = "";
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.textContent ?? "";
            return;
        }
        if (isViewOnlyDom(node)) return;
        for (const child of node.childNodes) walk(child);
    };
    // The root itself is not marker-checked: callers pass the render element
    // they are reading, which is never a decoration itself.
    if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
    for (const child of root.childNodes) walk(child);
    return out;
};