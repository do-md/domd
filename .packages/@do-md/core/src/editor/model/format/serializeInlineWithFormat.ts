import { CursorMarker } from "../../constant";
import {
    InlineFormat,
    InlineFormatMark,
    ParentRenderData,
    RenderData,
} from "../../type";
import { MARK_CLOSE, MARK_OPEN, orderMarks } from "./marks";
import { InlineItem, toggledInlineItems } from "./inlineItems";

/**
 * Re-serialize the inline content of a single block, toggling one inline mark
 * over the selection [start, end] (offsets into the block's serialized string,
 * already adjusted by `adjustCursor_`). CursorMarkers are placed at the two
 * boundaries so the selection is restored on the (now reformatted) text.
 *
 * Path B: decompose into a flat token stream (see `decomposeInlineItems`), flip
 * the requested mark for in-range tokens, then emit minimal nested markers. The
 * whole block's inline is canonicalized (symbol regeneration), which the caller
 * has opted into. Atomic tokens are preserved verbatim and only gain/lose an
 * outer mark; selection inside them is snapped to their boundary.
 */
export const serializeInlineWithFormat = (
    blockNode: ParentRenderData | RenderData,
    start: number,
    end: number,
    format: InlineFormat,
): string => {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);

    type Item = InlineItem;
    const items = toggledInlineItems(blockNode, lo, hi, format);

    // Insert CursorMarkers at the selection boundaries, just inside the
    // reformatted run so the restored selection covers the formatted text.
    const idxStart = items.findIndex((it) => it.sp >= lo);
    const startAt = idxStart === -1 ? items.length : idxStart;
    const idxEnd = items.findIndex((it) => it.sp >= hi);
    const endAt = idxEnd === -1 ? items.length : idxEnd;

    const cursorItem = (neighbor: Item | undefined): Item => ({
        text: CursorMarker,
        marks: new Set(neighbor ? neighbor.marks : []),
        sp: -1,
        len: 0,
        isCursor: true,
    });
    // Splice the later index first so the earlier index stays valid.
    items.splice(endAt, 0, cursorItem(items[endAt - 1] ?? items[endAt]));
    items.splice(startAt, 0, cursorItem(items[startAt] ?? items[startAt - 1]));

    // Emit with minimal nested markers: longest common prefix of the open mark
    // stack and the target set stays open; only the suffix is closed/reopened.
    let out = "";
    let curList: InlineFormatMark[] = [];
    for (const item of items) {
        const tgtList = orderMarks(item.marks);
        let k = 0;
        while (
            k < curList.length &&
            k < tgtList.length &&
            curList[k] === tgtList[k]
        ) {
            k += 1;
        }
        for (let i = curList.length - 1; i >= k; i -= 1) {
            out += MARK_CLOSE[curList[i]];
        }
        for (let i = k; i < tgtList.length; i += 1) {
            out += MARK_OPEN[tgtList[i]];
        }
        curList = tgtList;
        out += item.text;
    }
    for (let i = curList.length - 1; i >= 0; i -= 1) {
        out += MARK_CLOSE[curList[i]];
    }
    return out;
};
