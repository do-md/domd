import { DATA_RENDER_ID } from "../../../data-parse/constant";

export const getIdByRenderDom = (node: HTMLElement) => {
    return node.getAttribute(DATA_RENDER_ID);
};