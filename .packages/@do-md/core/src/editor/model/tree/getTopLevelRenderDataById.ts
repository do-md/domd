import { ParentRenderData, RenderData, RootRenderData } from "../../type";

// Returns the top-level child of RootRenderData (or any ParentRenderData) that
// contains the given uuid. Use this when round-trip needs the full block
// context (e.g. AI streaming into a code block nested in a list — the OL
// indent must be visible to parseOL on reparse).
export const getTopLevelRenderDataById = (
    uuid: string,
    rootData: ParentRenderData | RootRenderData,
): ParentRenderData | RenderData | null => {
    if (!rootData.children_) return null;

    for (const topChild of rootData.children_) {
        const stack: (ParentRenderData | RenderData)[] = [topChild];
        while (stack.length) {
            const node = stack.pop()!;
            if (node.uuid_ === uuid) return topChild;
            if (node.children_) {
                for (let i = node.children_.length - 1; i >= 0; i--) {
                    stack.push(node.children_[i]);
                }
            }
        }
    }

    return null;
};
