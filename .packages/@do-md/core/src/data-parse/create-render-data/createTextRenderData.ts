import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { RenderData } from "../../editor/type";

export const createTextRenderData = (
    renderdata: Partial<RenderData>,
): RenderData => {
    return {
        htmlType_: MarkdownType.Plain,
        text_: "",
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
        ...renderdata,
    };
};
