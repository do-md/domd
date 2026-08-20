import {
    InlineFormat,
    InlineFormatMark,
    ParentRenderData,
    RenderData,
} from "../../type";
import { MARK_CLOSE, MARK_OPEN, orderMarks } from "./marks";
import { toggledInlineItems } from "./inlineItems";

/**
 * Whether toggling this format would force two `*`-based delimiter groups
 * (bold `**` / italic `*`) to sit immediately adjacent in the output — e.g.
 * `**a** **b**` + italic → `***a**** ****b***`. Our `*` matcher is greedy
 * (not CommonMark delimiter-run), so such merged star runs mis-nest. `~~` / `==`
 * never collide. Callers swallow the op instead of writing a mangled result.
 *
 * Detected at the source: at each token boundary the emitter closes the suffix
 * of the open-mark stack and opens the target's suffix; a conflict is a closing
 * group ending in `*` butted directly against an opening group starting with `*`
 * (no content/`~~`/`==` between them).
 */
export const inlineFormatHasStarConflict = (
    blockNode: ParentRenderData | RenderData,
    start: number,
    end: number,
    format: InlineFormat,
): boolean => {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const items = toggledInlineItems(blockNode, lo, hi, format);

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
        const closeStr = curList
            .slice(k)
            .reverse()
            .map((m) => MARK_CLOSE[m])
            .join("");
        const openStr = tgtList
            .slice(k)
            .map((m) => MARK_OPEN[m])
            .join("");
        if (closeStr.endsWith("*") && openStr.startsWith("*")) return true;
        curList = tgtList;
    }
    return false;
};
