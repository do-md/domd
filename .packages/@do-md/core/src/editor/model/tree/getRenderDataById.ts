import { ParentRenderData, RenderData } from "../../type";

/** Pre-order DFS lookup of a node by uuid; returns null when not found. */
export const getRenderDataById = (
    uuid: string,
    parsedData: ParentRenderData,
): RenderData | ParentRenderData | null => {
    const stack: (ParentRenderData | RenderData)[] = [parsedData];

    while (stack.length) {
        const node = stack.pop();

        if (node) {
            if (node.uuid_ === uuid) {
                return node;
            } else if (node.children_) {
                // Push children to the stack in reverse order to maintain the correct processing order
                for (let i = node.children_.length - 1; i >= 0; i--) {
                    stack.push(node.children_[i]);
                }
            }
        }
    }

    return null;
};
