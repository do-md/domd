import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { CursorInfo, ParentRenderData } from "../../editor/type";
import { getParseContext } from "../parseMarkdown";
import { DATA_RENDER_ID } from "../constant";

export const createEmptyP = (
    withPlaceHolder = true,
): [ParentRenderData, CursorInfo] => {
    const { placeholderText_: placeholderText = "" } = getParseContext();
    const id = nanoid8();

    return [
        {
            htmlType_: MarkdownType.EmptyP,
            children_: [
                {
                    htmlType_: MarkdownType.Br,
                    text_: "",
                    mdSymbols_: [],
                    uuid_: nanoid8(),
                    htmlProps_: {},
                },
            ],
            mdSymbols_: [],
            uuid_: id,
            htmlProps_: {
                [DATA_RENDER_ID]: id,
                // placeholder: withPlaceHolder ? placeholderText : undefined,
            },
        },
        {
            uuid: id,
            offset: 0,
        },
    ];
};
