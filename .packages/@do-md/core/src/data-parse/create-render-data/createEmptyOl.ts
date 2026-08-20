import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { CursorInfo, ParentRenderData } from "../../editor/type";
import { DATA_RENDER_ID } from "../constant";
import { createEmptyP } from "./createEmptyP";

export const createEmptyOl = (): [ParentRenderData, CursorInfo] => {
    const olID = nanoid8();
    const liID = nanoid8();
    const [emptyP, cursorInfo] = createEmptyP();
    return [
        {
            htmlType_: MarkdownType.Ol,
            children_: [
                {
                    htmlType_: MarkdownType.li,
                    children_: [emptyP],
                    uuid_: liID,
                    mdSymbols_: [],
                    htmlProps_: {
                        [DATA_RENDER_ID]: liID,
                        start: 0,
                    },
                },
            ],
            uuid_: olID,
            mdSymbols_: [],
            htmlProps_: {
                [DATA_RENDER_ID]: olID,
            },
        },
        cursorInfo,
    ];
};
