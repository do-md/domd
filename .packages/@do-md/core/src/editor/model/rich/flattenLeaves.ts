import { ParentRenderData, RenderData } from "../../type";
import { isSymbolType } from "../../constant";

/**
 * The leaf-flattening primitive shared across the rich module: block → a
 * sequence of leaves carrying their in-block offset ranges. Every decision
 * that pairs a cursor offset with the symbol-leaf structure (tunnelling,
 * normalization, input takeover) is built on top of this.
 */

export interface Leaf {
    start_: number;
    end_: number;
    data_: RenderData;
}

export const isSymbolLeaf = (data: RenderData): boolean =>
    isSymbolType(data.htmlType_);

// renderData nodes are frozen immutable by immer — the same reference always
// maps to the same leaf sequence. A single keystroke / backspace / formatState
// derivation consumes one block's flattened leaves from several places, and
// the WeakMap cache collapses those repeated walks into one (a changed
// reference = a new entry, so there is nothing to invalidate).
const leavesCache = new WeakMap<ParentRenderData, Leaf[]>();

export const flattenLeaves = (node: ParentRenderData): Leaf[] => {
    const cached = leavesCache.get(node);
    if (cached) return cached;
    const leaves: Leaf[] = [];
    let pos = 0;
    const walk = (parent: ParentRenderData) => {
        for (const child of parent.children_) {
            if (child.children_) {
                walk(child);
            } else {
                const len = child.text_?.length ?? 0;
                leaves.push({ start_: pos, end_: pos + len, data_: child });
                pos += len;
            }
        }
    };
    walk(node);
    leavesCache.set(node, leaves);
    return leaves;
};
