import { ParentRenderData } from "../../../../../../type";
import { HtmlTags } from "../../../../../../constant";
import { memo } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";

interface Props {
    parsedData: ParentRenderData;
}
function SelfCloseElement({ parsedData }: Props) {
    const Tag = HtmlTags[parsedData.htmlType_];
    const props = getRenderElementProps(parsedData);
    return <Tag {...props} />;
}

export default memo(SelfCloseElement);
