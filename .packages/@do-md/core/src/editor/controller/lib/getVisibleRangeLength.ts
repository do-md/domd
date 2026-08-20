import { DATA_VIEW_ONLY } from "../../../data-parse/constant";

/**
 * Visible text length of a Range — `range.toString().length` minus the text
 * of view-only decorations lying inside it. Used by every cursor-offset
 * computation so DOM offsets stay aligned with `getVisibleDomText` output.
 *
 * A caret can never sit INSIDE a view-only element (they are
 * contentEditable=false by contract), so decorations are subtracted
 * all-or-nothing: only those fully contained in the range.
 */
export const getVisibleRangeLength = (range: Range): number => {
    let len = range.toString().length;
    const anchor = range.commonAncestorContainer;
    const anchorEl =
        anchor.nodeType === Node.ELEMENT_NODE
            ? (anchor as Element)
            : anchor.parentElement;
    if (!anchorEl) return len;
    for (const el of anchorEl.querySelectorAll(`[${DATA_VIEW_ONLY}]`)) {
        const textLen = el.textContent?.length ?? 0;
        if (!textLen) continue;
        const elRange = el.ownerDocument.createRange();
        elRange.selectNodeContents(el);
        if (
            range.compareBoundaryPoints(Range.END_TO_END, elRange) >= 0 &&
            range.compareBoundaryPoints(Range.START_TO_START, elRange) <= 0
        ) {
            len -= textLen;
        }
    }
    return len;
};