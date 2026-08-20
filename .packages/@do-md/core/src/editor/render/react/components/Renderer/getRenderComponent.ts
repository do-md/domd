import BaseElement from "./base/BaseElement";
import SelfCloseElement from "./base/SelfCloseElement";
import CodeAreaElement from "./elements/CodeAreaElement";
import MdSymbolElement from "./elements/MdSymbolElement";
import RootElement from "./elements/RootElement";
import HTMLElement from "./elements/HTMLElement";
import LinkElement from "./elements/LinkElement";
import TableElement from "./elements/TableElement";
import CheckboxesElement from "./elements/CheckboxesElement";
import HrElement from "./elements/HrElement";
import ImgElement from "./elements/ImgElement";
import InlineRuleSpanElement from "./elements/InlineRuleSpanElement";
import { MarkdownType } from "../../../../type/enum";
import { ParentRenderData, RenderData } from "../../../../type";

/** The React element registry: MarkdownType → render component
 *  (React-specific; the framework-neutral prop derivation lives in
 *  render/props/). Types not listed here fall through to BaseElement's
 *  generic rendering. */
export const getRenderComponent = (
    markdownType: MarkdownType,
): React.ComponentType<{ parsedData: ParentRenderData | RenderData }> => {
    if (markdownType === MarkdownType.Root)
        return RootElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.HTML)
        return HTMLElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.HrDiv) {
        return HrElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    }
    if (markdownType === MarkdownType.Br || markdownType === MarkdownType.Hr)
        return SelfCloseElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.Img)
        return ImgElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.MdSymbol) return MdSymbolElement;
    if (markdownType === MarkdownType.InlineRuleSpan)
        return InlineRuleSpanElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.Pre)
        return CodeAreaElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.Link)
        return LinkElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.Table)
        return TableElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    if (markdownType === MarkdownType.CheckboxesInput) {
        return CheckboxesElement as React.ComponentType<{
            parsedData: ParentRenderData | RenderData;
        }>;
    }
    return BaseElement;
};
