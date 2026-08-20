import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { ParentRenderData } from "../../editor/type";
import { DATA_RENDER_ID } from "../constant";

export const createParentRenderData = (
    parentRenderData: Partial<ParentRenderData>,
    withRenderId = true,
): ParentRenderData => {
    const uuid_ = parentRenderData.uuid_ || nanoid8();
    const htmlProps_ = parentRenderData.htmlProps_ || {};
    if (withRenderId) {
        htmlProps_[DATA_RENDER_ID] = uuid_;
    }

    return {
        htmlType_: MarkdownType.P,
        children_: [],
        mdSymbols_: [],
        ...parentRenderData,
        uuid_,
        htmlProps_,
    };
};
