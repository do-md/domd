import { DATA_RENDER_ID } from "../../../data-parse/constant";

export const getClosestRenderDom = (node: HTMLElement) => {
    return node.closest(`[${DATA_RENDER_ID}]`) as HTMLElement | null;
};