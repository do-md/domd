import { ParentRenderData, RenderData } from "../../type";

/**
 * Finds which text leaf `pos` falls on, addressed in "text offset within the
 * block" coordinates (a running sum of raw text_ lengths — the same coordinate
 * space as toMarkdown / blockTextLength). Also reports the render block that
 * leaf belongs to (its nearest data-render-id ancestor) and the cursor position
 * relative to that block. Returns {} when there is no match.
 */
export const getNodeInfo = (pos: number, renderData: ParentRenderData) => {
    let totalCheckedPos = 0;
    let curRenderCheckedPos = 0;

    const queue: {
        curNode: RenderData | ParentRenderData;
        renderNode: ParentRenderData | null;
        renderNodeParent: ParentRenderData | null;
        parentNode: ParentRenderData | null;
    }[] = [
        {
            curNode: renderData,
            renderNode: null,
            renderNodeParent: null,
            parentNode: null,
        },
    ];

    while (queue.length) {
        const node = queue.pop();
        if (!node) throw Error("Node does not exist");
        const { curNode, renderNode, renderNodeParent, parentNode } = node;
        let newRenderNode: ParentRenderData | null = renderNode;
        let newRenderNodeParent: ParentRenderData | null = renderNodeParent;

        if (curNode.htmlProps_["data-render-id"]) {
            newRenderNode = curNode as ParentRenderData;
            newRenderNodeParent = parentNode as ParentRenderData | null;
            curRenderCheckedPos = 0;
        }

        // If node has text property
        if (typeof curNode.text_ === "string") {
            const textLength = curNode.text_.length;
            if (
                (pos > totalCheckedPos &&
                    pos <= totalCheckedPos + curNode.text_.length) ||
                pos === 0
            ) {
                return {
                    renderNode: newRenderNode,
                    renderCursor: pos - totalCheckedPos + curRenderCheckedPos,
                    curNode,
                    renderNodeParent: newRenderNodeParent,
                };
            }
            totalCheckedPos += textLength;
            curRenderCheckedPos += textLength;
        } else if (curNode.children_) {
            // If node has children property, enqueue child nodes
            for (let i = curNode.children_.length - 1; i >= 0; i--) {
                queue.push({
                    curNode: curNode.children_[i],
                    renderNode: newRenderNode,
                    renderNodeParent: newRenderNodeParent,
                    parentNode: curNode,
                });
            }
        }
    }

    return {};
};
