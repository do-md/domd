import { ParentRenderData } from "../../type";
import { flattenLeaves, isSymbolLeaf, Leaf } from "./flattenLeaves";

/**
 * Rich-mode **block-split affinity** normalization (the single implementation,
 * used by Enter and the other block-splitting operations): when the cursor
 * lands inside or at the leading edge of a closing symbol run (`**bold|**` —
 * the construct-tail typing position) it hops past that run, and nesting is
 * followed run by run. The semantics are a product decision: **typing affinity
 * = inside** (typing at a construct tail continues the format, so nothing is
 * normalized), **block-split affinity = outside** (pressing Enter at a
 * construct tail must split after the construct — it must never push the
 * syntax symbols onto the next line). Opening runs (content follows the
 * symbol) and atomic constructs (images, content length 0) are left alone.
 */
export const normalizeRichCursorOffset = (
    renderData: ParentRenderData,
    offset: number,
): number => {
    const leaves = flattenLeaves(renderData);
    const leafAt = (charIndex: number): Leaf | undefined =>
        leaves.find((l) => l.start_ <= charIndex && charIndex < l.end_);
    let o = offset;
    for (;;) {
        const leaf = leafAt(o);
        if (!leaf || !isSymbolLeaf(leaf.data_)) break;
        const ids = leaf.data_.mdSymbols_ ?? [];
        // Closing-side test: the same construct has a non-empty content leaf
        // that ends before this symbol.
        const hasContentBefore = leaves.some(
            (l) =>
                !isSymbolLeaf(l.data_) &&
                l.end_ > l.start_ &&
                l.end_ <= leaf.start_ &&
                (l.data_.mdSymbols_ ?? []).some((id) => ids.includes(id)),
        );
        if (!hasContentBefore) break;
        o = leaf.end_;
    }
    return o;
};
