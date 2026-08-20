import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { RenderData } from "../../editor/type";

export const createHideSecondLine = (isAutoFill_ = false): RenderData => {
    return {
        htmlType_: MarkdownType.HideSecondLine,
        text_: "\n",
        uuid_: nanoid8(),
        isAutoFill_: isAutoFill_ || undefined,
        mdSymbols_: [],
        htmlProps_: {},
    };
};
