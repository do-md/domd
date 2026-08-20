import { DATA_RENDER_ID } from "../../../data-parse/constant";
import { ParentRenderData, RenderData, RootRenderData } from "../../type";

/** BFS for the last render block (a node carrying DATA_RENDER_ID) in a subtree. */
export const getLastRender = (
    parseData: RootRenderData | ParentRenderData | RenderData,
): ParentRenderData | null => {
    let lastRenderData = null;

    const queue: (RootRenderData | ParentRenderData | RenderData)[] = [
        parseData,
    ];

    while (queue.length) {
        const len = queue.length;

        for (let i = 0; i < len; i += 1) {
            const cur = queue.shift();

            if (cur?.htmlProps_[DATA_RENDER_ID]) {
                lastRenderData = cur;
            }

            cur?.children_?.forEach((child) => {
                queue.push(child);
            });
        }
    }

    return lastRenderData as ParentRenderData;
};
