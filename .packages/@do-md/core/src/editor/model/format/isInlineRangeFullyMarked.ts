import {
    InlineFormatMark,
    ParentRenderData,
    RenderData,
} from "../../type";
import { decomposeInlineItems } from "./inlineItems";

/**
 * Whether every token in [start, end] already carries `mark`. Drives the
 * add-vs-strip toggle direction: fully marked -> strip, otherwise add.
 * Empty range (no tokens) reports false so the action defaults to add.
 */
export const isInlineRangeFullyMarked = (
    blockNode: ParentRenderData | RenderData,
    start: number,
    end: number,
    mark: InlineFormatMark,
): boolean => {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const inRange = decomposeInlineItems(blockNode).filter(
        (it) => it.sp < hi && it.sp + it.len > lo,
    );
    return inRange.length > 0 && inRange.every((it) => it.marks.has(mark));
};
