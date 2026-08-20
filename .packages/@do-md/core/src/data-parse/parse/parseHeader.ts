import { MarkdownType } from "../../editor/type/enum";
import { CursorInfo, ParentRenderData, RenderData } from "../../editor/type";
import { parseInline } from "./parseInline";
import { nanoid8 } from "@do-md/utils";
import { CursorMarker } from "../../editor/constant";
import { extractFirstMarkdownHeader } from "../gettext/extractFirstMarkdownHeader";
import { getParseContext } from "../parseMarkdown";

export const parseHeader = ({
    text_,
    parentRenderData_,
}: {
    text_: string;
    parentRenderData_: ParentRenderData;
}) => {
    const { onCursorFound_: onCursorFound } = getParseContext();
    const cursorIndex = text_.indexOf(CursorMarker);
    if (cursorIndex !== -1) {
        text_ =
            text_.slice(0, cursorIndex) +
            text_.slice(cursorIndex + CursorMarker.length);
    }

    const id = nanoid8();
    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.H1,
        children_: [],
        uuid_: id,
        mdSymbols_: [],
        htmlProps_: {
            "data-render-id": id,
        },
    };

    if (cursorIndex !== -1) {
        onCursorFound?.({
            uuid: lineRenderData.uuid_,
            offset: cursorIndex,
        });
    }

    const symbol = extractFirstMarkdownHeader(text_);

    if (!symbol) throw Error("no symbol");
    switch (symbol) {
        case "# ":
            lineRenderData.htmlType_ = MarkdownType.H1;
            break;
        case "## ":
            lineRenderData.htmlType_ = MarkdownType.H2;
            break;
        case "### ":
            lineRenderData.htmlType_ = MarkdownType.H3;
            break;
        case "#### ":
            lineRenderData.htmlType_ = MarkdownType.H4;
            break;
        case "##### ":
            lineRenderData.htmlType_ = MarkdownType.H5;
            break;
        case "###### ":
            lineRenderData.htmlType_ = MarkdownType.H6;
            break;
        default:
            break;
    }

    const mdSymbolId = nanoid8();

    const mdSymbol: RenderData = {
        htmlType_: MarkdownType.MdSymbol,
        text_: symbol,
        uuid_: mdSymbolId,
        mdSymbols_: [mdSymbolId],
        htmlProps_: {},
    };

    const remainText = text_.slice(symbol.length);

    const nextParent: ParentRenderData = {
        htmlType_: remainText.length ? MarkdownType.Plain : MarkdownType.Br,
        children_: [],
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };
    lineRenderData.children_.push(mdSymbol, nextParent);

    const remainingLineText = parseInline({
        parseText_: remainText,
        renderData_: nextParent,
    });

    if (remainingLineText) {
        nextParent.children_.push({
            htmlType_: MarkdownType.Plain,
            text_: remainingLineText,
            uuid_: nanoid8(),
            mdSymbols_: [],
            htmlProps_: {},
        });
    }

    parentRenderData_.children_.push(lineRenderData);
};
