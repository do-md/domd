import { ParentRenderData } from "../../type";
import { flattenLeaves, isSymbolLeaf } from "./flattenLeaves";

/** Input-takeover test for rich mode: true when the character before a
 *  collapsed cursor sits inside a symbol leaf. The browser's own insertion
 *  must not be let through here — Chrome's typing-style continuation ignores
 *  the caret's DOM position and stuffs the character into the preceding
 *  formatting element, styled after the previous visible character (the DOM
 *  reads back as `**boldx**` → the reparse keeps it bold). Callers should
 *  preventDefault and go through the kernel's insertText instead. */
export const isCursorAfterSymbol = (
    renderData: ParentRenderData,
    offset: number,
): boolean => {
    if (offset <= 0) return false;
    const leaves = flattenLeaves(renderData);
    const leaf = leaves.find(
        (l) => l.start_ <= offset - 1 && offset - 1 < l.end_,
    );
    return !!leaf && isSymbolLeaf(leaf.data_);
};
