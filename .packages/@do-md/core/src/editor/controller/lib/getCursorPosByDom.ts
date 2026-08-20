import { getVisibleRangeLength } from "./getVisibleRangeLength";

/**
 * Get the position of the cursor.
 * @param textAreaDom
 * @returns
 */
export const getCursorPosByDom = (textAreaDom: HTMLElement) => {
    const selection = document.getSelection();
    if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(textAreaDom);
        preCaretRange.setEnd(range.endContainer, range.endOffset);

        return getVisibleRangeLength(preCaretRange);
    } else {
        return 0;
    }
};