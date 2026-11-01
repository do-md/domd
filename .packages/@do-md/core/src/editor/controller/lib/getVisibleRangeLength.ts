import { DATA_VIEW_ONLY } from "../../../data-parse/constant";

/**
 * Visible text length of a Range — `range.toString().length` minus the text
 * of view-only decorations lying inside it. Used by every cursor-offset
 * computation so DOM offsets stay aligned with `getVisibleDomText` output.
 *
 * A caret never sits inside a view-only element (contentEditable=false), but
 * a selection endpoint can: on a read-only surface, or a programmatic range,
 * a drag may start in the middle of a text-bearing badge. So each decoration
 * subtracts only the part of it the range covers, which puts an endpoint
 * inside a decoration at the decoration's start in model terms. Nested
 * decorations are counted once, through their outermost view-only ancestor.
 */
export const getVisibleRangeLength = (range: Range): number => {
    let len = range.toString().length;
    const anchor = range.commonAncestorContainer;
    const anchorEl =
        anchor.nodeType === Node.ELEMENT_NODE
            ? (anchor as Element)
            : anchor.parentElement;
    if (!anchorEl) return len;
    // The whole range sits inside one decoration: none of it is model text.
    if (anchorEl.closest(`[${DATA_VIEW_ONLY}]`)) return 0;
    for (const el of anchorEl.querySelectorAll(`[${DATA_VIEW_ONLY}]`)) {
        if (el.parentElement?.closest(`[${DATA_VIEW_ONLY}]`)) continue;
        if (!el.textContent) continue;
        const covered = el.ownerDocument.createRange();
        covered.selectNodeContents(el);
        // Clip the decoration to the range; disjoint means nothing to subtract.
        if (range.compareBoundaryPoints(Range.START_TO_START, covered) > 0) {
            covered.setStart(range.startContainer, range.startOffset);
        }
        if (range.compareBoundaryPoints(Range.END_TO_END, covered) < 0) {
            covered.setEnd(range.endContainer, range.endOffset);
        }
        if (covered.collapsed) continue;
        len -= covered.toString().length;
    }
    return len;
};
