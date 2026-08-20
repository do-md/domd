import { getClosestRenderDom } from "./getClosestRenderDom";
import { getCursorPosByDom } from "./getCursorPosByDom";
import { getDomByCursor } from "./getDomByCursor";

 export const getParentRenderDom = (textAreaDom:HTMLDivElement) => {
        const index = getCursorPosByDom(textAreaDom);
        const node = getDomByCursor(textAreaDom, index);
        if (!node.node?.parentNode) return null;
        const renderParent = getClosestRenderDom(
            node.node.parentNode as HTMLElement,
        );

        return renderParent;
    }