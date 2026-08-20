import { MarkdownType } from "../../editor/type/enum";
import { ParentRenderData } from "../../editor/type";
import { DATA_RENDER_ID } from "../constant";

export const createLiParent = (
    id: string,
    mdSymbolId: string,
): ParentRenderData => {
    return {
        htmlType_: MarkdownType.li,
        children_: [],
        uuid_: id,
        mdSymbols_: [mdSymbolId],
        htmlProps_: {
            [DATA_RENDER_ID]: id,
        },
    };
};
