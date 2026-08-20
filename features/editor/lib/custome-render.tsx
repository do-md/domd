import TableElement from "@/plugins/rendering/TableElement";
import { MarkdownType, RenderElementProps } from "@do-md/core-react";
import { ComponentType } from "react";

export const CustomRender: Partial<
    Record<MarkdownType, ComponentType<RenderElementProps>>
> = {
    [MarkdownType.Table]: TableElement,
};
