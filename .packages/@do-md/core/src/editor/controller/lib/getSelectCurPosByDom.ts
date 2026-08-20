import { getVisibleRangeLength } from "./getVisibleRangeLength";

/**
 * Get the position of the selected text.
 * @param textAreaDom
 * @returns
 */
export const getSelectCurPosByDom = (textAreaDom: HTMLElement) => {
    // Get the document selection; the selection carries the range(s).
    const selection = document.getSelection();
    if (selection && selection.rangeCount) {
        // Copy the current range.
        const range = selection.getRangeAt(0);

        const startCaretRange = new Range();
        startCaretRange.selectNodeContents(textAreaDom);
        startCaretRange.setEnd(range.startContainer, range.startOffset);

        const endCaretRange = new Range();
        endCaretRange.selectNodeContents(textAreaDom);
        endCaretRange.setEnd(range.endContainer, range.endOffset);

        return [
            getVisibleRangeLength(startCaretRange),
            getVisibleRangeLength(endCaretRange),
        ];
    }
    return [0, 0];
};