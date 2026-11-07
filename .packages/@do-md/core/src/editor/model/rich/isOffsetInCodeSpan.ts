import { ParentRenderData } from "../../type";
import { MarkdownType } from "../../type/enum";
import { flattenLeaves } from "./flattenLeaves";

/** True when a text inserted at block offset `offset` would land inside a
 *  code span's content: anywhere from right after the opening backticks to
 *  right before the closing ones. */
export const isOffsetInCodeSpan = (
    renderData: ParentRenderData,
    offset: number,
): boolean =>
    flattenLeaves(renderData).some(
        (leaf) =>
            leaf.data_.htmlType_ === MarkdownType.Code &&
            leaf.start_ <= offset &&
            offset <= leaf.end_,
    );
