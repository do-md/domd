import TableElement from "@/plugins/rendering/TableElement";
import { MarkdownType, RenderData } from "@do-md/core-react";
import { ComponentType } from "react";

export const CustomRender: Partial<
    Record<MarkdownType, ComponentType<{ parsedData: RenderData }>>
> = {
    [MarkdownType.Table]: TableElement,
};