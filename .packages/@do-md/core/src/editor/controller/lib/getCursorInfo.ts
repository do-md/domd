import { getClosestRenderDom } from "./getClosestRenderDom";
import { getIdByRenderDom } from "./getIdByRenderDom";
import { getVisibleRangeLength } from "./getVisibleRangeLength";

/**
 * Map a DOM Range's endpoints to render coordinates: one entry
 * ({ renderElement, renderUUID, visible offset }) for a collapsed range,
 * two (start, end) otherwise, empty when an endpoint lies outside any
 * render element. Shared by the live-selection reading (getCursorInfo)
 * and by takeover paths that address a browser-computed range instead of
 * the selection (forward delete's beforeinput target range).
 */
export const getCursorInfoOfRange = (range: Range) => {
    const isCollapsed = range.collapsed;

    const getRenderElementInfo = (container: Node) => {
        const parentElement =
            container instanceof HTMLElement
                ? container
                : container.parentElement;
        if (!parentElement) return null;
        const renderElement = getClosestRenderDom(parentElement);
        if (!renderElement) return null;
        return {
            renderElement,
            renderUUID: getIdByRenderDom(renderElement) as string,
            commonAncestorContainer: range.commonAncestorContainer,
        };
    };

    const startInfo = getRenderElementInfo(range.startContainer);
    if (!startInfo) return [];

    if (isCollapsed) {
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(startInfo.renderElement);
        preCaretRange.setEnd(range.endContainer, range.endOffset);
        return [
            {
                ...startInfo,
                offset: getVisibleRangeLength(preCaretRange),
            },
        ];
    } else {
        const endInfo = getRenderElementInfo(range.endContainer);
        if (!endInfo) return [];

        const startCaretRange = range.cloneRange();
        startCaretRange.selectNodeContents(startInfo.renderElement);
        startCaretRange.setEnd(range.startContainer, range.startOffset);

        const endCaretRange = range.cloneRange();
        endCaretRange.selectNodeContents(endInfo.renderElement);
        endCaretRange.setEnd(range.endContainer, range.endOffset);

        return [
            {
                ...startInfo,
                offset: getVisibleRangeLength(startCaretRange),
            },
            {
                ...endInfo,
                offset: getVisibleRangeLength(endCaretRange),
            },
        ];
    }
};

export const getCursorInfo = () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return [];
    }
    return getCursorInfoOfRange(selection.getRangeAt(0));
};
