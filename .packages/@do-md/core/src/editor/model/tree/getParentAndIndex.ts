import { ParentRenderData, RenderData } from "../../type";

/** BFS for the parent of the node with `uuid`, plus its index in that
 *  parent's children_. */
export const getParentAndIndex = (
    uuid: string,
    parsedData: ParentRenderData,
) => {
    const queue: (ParentRenderData | RenderData)[] = [parsedData];

    while (queue.length) {
        const node = queue.shift();

        if (node) {
            const index = node.children_
                ? node.children_.findIndex((data) => data.uuid_ === uuid)
                : -1;

            if (index !== -1) {
                return {
                    parent: node as ParentRenderData,
                    index,
                };
            } else if (node.children_) {
                queue.push(...node.children_);
            }
        }
    }
};
