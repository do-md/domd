import {
    CursorInfo,
    ParentRenderData,
    RootRenderData,
    Token,
    HtmlTagToken,
    HtmlTextToken,
    RenderData,
} from "../../editor/type";
// import { getDetailsTag } from "../gettext/getDetailsTag";
// import { parseDetail } from "./parseDetail";
import { getHeaderAreaText } from "../gettext/getHeaderAreaText";
import { parseHeader } from "./parseHeader";
import { getCodeAreaText } from "../gettext/getCodeAreaText";
import { parseCode } from "./parseCode";
import { getULAreaText } from "../gettext/getULAreaText";
import { parseUL } from "./parseUL";
import { OL_LINE_REG } from "../reg";
import { getOLAreaText } from "../gettext/getOLAreaText";
import { parseOL } from "./parseOL";
import { parseP } from "./parseP";
import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { CursorMarker } from "../../editor/constant";
import { getBlockquoteAreaText } from "../gettext/getBlockquoteAreaText";
import { getHrAreaText } from "../gettext/getHrAreaText";
import { parseBlockquote } from "./parseBlockquote";
import { extractLeadingHtmlBlocks } from "../gettext/getHTMLText";
import { extractTableText } from "../gettext/extractTableText";
import { parseTable } from "./parseTable";
import { parseInline } from "./parseInline";
import { getParseContext } from "../parseMarkdown";
import { createEmptyP } from "../create-render-data/createEmptyP";

export const parseBlock = ({
    text_,
    parentRenderData_,
    rootRenderData_,
}: {
    text_: string;
    parentRenderData_: ParentRenderData;
    rootRenderData_: RootRenderData;
}) => {
    const { onCursorFound_: onCursorFound, htmlTokenizer_: htmlTokenizer } =
        getParseContext();
    if (text_.startsWith("\n\n")) {
        const uuid = nanoid8();
        const lineBrBr: RenderData = {
            htmlType_: MarkdownType.LineBrBr,
            text_: "\n\n",
            uuid_: uuid,
            mdSymbols_: [],
            htmlProps_: {},
        };
        if (text_ === `\n\n${CursorMarker}` || text_ === "\n\n") {
            const [emptyP, cursorInfo] = createEmptyP(false);
            onCursorFound?.(cursorInfo);
            parentRenderData_.children_.push(emptyP);
            parentRenderData_.children_.push(lineBrBr);
            const [nextP] = createEmptyP(false);
            parentRenderData_.children_.push(nextP);
            return text_.slice(text_.length);
        } else {
            parentRenderData_.children_.push(createEmptyP(false)[0]);
            parentRenderData_.children_.push(lineBrBr);
        }

        // if (text_.startsWith("\n\n\n")) {
        //     parentRenderData_.children_.push(createEmptyP(false)[0]);
        // }

        return text_.slice(2);
    } else if (text_.startsWith("\n")) {
        // A single `\n` separates two blocks that are tight (no blank line),
        // e.g. a heading/hr directly followed by a list/table/blockquote. It
        // must survive as a LineBr node — otherwise toMarkdown's join("")
        // welds the two blocks onto one line (round-trip fidelity loss).
        // Mirrors parseP's own LineBr handling for the paragraph→block seam.
        parentRenderData_.children_.push({
            htmlType_: MarkdownType.LineBr,
            text_: "\n",
            uuid_: nanoid8(),
            mdSymbols_: [],
            htmlProps_: {},
        });
        return text_.slice(1);
    }
    // Leading `\` escapes the entire line from block-marker recognition.
    // Route directly to the paragraph path; parseInline's `\` branch will
    // emit MdSymbol("\\") + Plain(nextChar) for any escapable sequence.
    if (text_.startsWith("\\")) {
        let pText;
        [pText, text_] = getPAreaText(text_);
        parseP({
            text_: pText,
            rootRenderData_: rootRenderData_,
            parentRenderData_: parentRenderData_,
        });
        return addlineBrBr({ text_, parentRenderData_ });
    }
    // if (text_.startsWith("<details")) {
    //     const result = getDetailsTag(text_);
    //     if (result) {
    //         parseDetail({
    //             summaryText_: result.titleText,
    //             contentText_: result.contentText,
    //             isOpen_: result.isOpen,
    //             parentRenderData_: parentRenderData_,
    //             rootRenderData_: rootRenderData_,
    //         });
    //         return text_.slice(result.end + 2);
    //     }
    // }
    if (text_.startsWith("#") || text_.startsWith(CursorMarker + "#")) {
        const headerText = getHeaderAreaText(text_);

        if (headerText) {
            parseHeader({
                text_: headerText,
                parentRenderData_: parentRenderData_,
            });
            return addlineBrBr({
                text_: text_.slice(headerText.length),
                parentRenderData_,
            });
        }
    }
    const hrText = getHrAreaText(text_);
    if (hrText) {
        const lineRenderData: ParentRenderData = {
            htmlType_: MarkdownType.HrDiv,
            uuid_: nanoid8(),
            children_: [
                {
                    htmlType_: MarkdownType.Hr,
                    uuid_: nanoid8(),
                    text_: hrText,
                    mdSymbols_: [],
                    htmlProps_: {},
                },
            ],
            mdSymbols_: [],
            htmlProps_: {
                contentEditable: false,
            },
        };

        parentRenderData_.children_.push(lineRenderData);
        return addlineBrBr({
            text_: text_.slice(hrText.length),
            parentRenderData_,
        });
    }

    if (text_.startsWith("```")) {
        const codeText = getCodeAreaText(text_);
        if (codeText) {
            parentRenderData_.children_.push(parseCode({ text_: codeText }));
            return addlineBrBr({
                text_: text_.slice(codeText.length),
                parentRenderData_,
            });
        }
    }

    if (text_.startsWith("|")) {
        const tableText = extractTableText(text_);

        if (tableText) {
            parentRenderData_.children_.push(
                parseTable({
                    text_: tableText,
                    rootRenderData_: rootRenderData_,
                }),
            );
            const textDraft = text_.slice(tableText.length);

            return addlineBrBr({
                text_: textDraft,
                parentRenderData_,
            });
        }
    }

    if (
        text_.startsWith("- ") ||
        text_ === "- " ||
        text_.startsWith("* ") ||
        text_ === "* " ||
        text_.startsWith("+ ") ||
        text_ === "+ "
    ) {
        const ulText = getULAreaText(text_);

        if (ulText) {
            const isTopLevel =
                parentRenderData_.htmlType_ !== MarkdownType.li &&
                parentRenderData_.htmlType_ !== MarkdownType.CheckBoxLi;
            parentRenderData_.children_.push(
                parseUL(ulText, rootRenderData_, isTopLevel),
            );
            const textDraft = text_.slice(ulText.length);

            return addlineBrBr({
                text_: textDraft,
                parentRenderData_,
            });
        }
    }
    if (text_.startsWith("> ")) {
        const blockquoteText = getBlockquoteAreaText(text_);

        if (blockquoteText) {
            const isTopLevel =
                parentRenderData_.htmlType_ !== MarkdownType.li &&
                parentRenderData_.htmlType_ !== MarkdownType.CheckBoxLi &&
                parentRenderData_.htmlType_ !== MarkdownType.Blockquote;
            parentRenderData_.children_.push(
                parseBlockquote(blockquoteText, rootRenderData_, isTopLevel),
            );
            const textDraft = text_.slice(blockquoteText.length);
            return addlineBrBr({
                text_: textDraft,
                parentRenderData_,
            });
        }
    }
    if (OL_LINE_REG.test(text_)) {
        const olText = getOLAreaText(text_);

        if (olText) {
            const isTopLevel =
                parentRenderData_.htmlType_ !== MarkdownType.li &&
                parentRenderData_.htmlType_ !== MarkdownType.CheckBoxLi;
            parentRenderData_.children_.push(
                parseOL(olText, rootRenderData_, isTopLevel),
            );

            const textDraft = text_.slice(olText.length);

            return addlineBrBr({
                text_: textDraft,
                parentRenderData_,
            });
        }
    }

    const html = extractLeadingHtmlBlocks(text_);
    if (html) {
        if (htmlTokenizer) {
            const tokens = htmlTokenizer?.(html) || [];
            htmlTokensToRenderData(
                tokens as any,
                parentRenderData_,
                rootRenderData_,
            );
        } else {
            parentRenderData_.children_.push({
                htmlType_: MarkdownType.HTML,
                tagName_: "div",
                text_: html,
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {},
            });
        }

        return addlineBrBr({
            text_: text_.slice(html.length),
            parentRenderData_,
        });
    }

    let pText;
    [pText, text_] = getPAreaText(text_);

    parseP({
        text_: pText,
        parentRenderData_: parentRenderData_,
        rootRenderData_: rootRenderData_,
    });
    return addlineBrBr({
        text_: text_,
        parentRenderData_,
    });
};

function getPAreaText(text: string) {
    // const brIndex = text.indexOf("\n");
    // if (brIndex !== -1) {
    //     /** example:
    //      * **Advantages**:
    //      * - ✅ **Stable reference**: same object reference while the deps
    //      *   are unchanged, so no needless re-render
    //      * - ✅ **Computed once**: every consumer shares one computed result
    //      * - ✅ **Auto cleanup**: memory is freed once no component uses it
    //      *   (RefCount)
    //      *  */
    //     return [text.slice(0, brIndex + 1) || "", text.slice(brIndex + 1)];
    // }
    const index = text.indexOf("\n\n");

    if (index === -1) {
        return [text, ""];
    }

    return [text.slice(0, index) || "", text.slice(index)];
}

const htmlTokensToRenderData = (
    tokens: (HtmlTagToken | HtmlTextToken)[],
    parentRenderData: ParentRenderData,
    rootRenderData: RootRenderData,
) => {
    return tokens.map((token) => {
        if (token.type === "tag") {
            const id = nanoid8();
            const renderData: ParentRenderData = {
                htmlType_: MarkdownType.HTML,
                tagName_: token.name,
                children_: [],
                uuid_: id,
                mdSymbols_: [],
                htmlProps_: {
                    "data-render-id": id,
                    ...token.attribs,
                },
            };
            if (token.name === "table") {
                const tableId = nanoid8();
                const tableData = {
                    htmlType_: MarkdownType.HTML,
                    tagName_: "div",
                    children_: [renderData],
                    uuid_: tableId,
                    mdSymbols_: [],
                    htmlProps_: {
                        "data-render-id": tableId,
                        className: "TableScrollable",
                    },
                };
                parentRenderData.children_.push(tableData);
            } else {
                parentRenderData.children_.push(renderData);
            }
            htmlTokensToRenderData(token.children, renderData, rootRenderData);
        } else if (
            token.type === "text" &&
            token.parent.type === "tag" &&
            token.parent.name !== "div" &&
            token.parent.name !== "td"
        ) {
            const remainingLineText = parseInline({
                parseText_: token.data,
                renderData_: parentRenderData,
            });

            if (remainingLineText) {
                parentRenderData.children_.push({
                    htmlType_: MarkdownType.Plain,
                    text_: remainingLineText,
                    uuid_: nanoid8(),
                    mdSymbols_: [],
                    htmlProps_: {},
                });
            }
        } else if (token.type === "text" && token.data.trim() !== "") {
            let text = token.data;

            do {
                text = parseBlock({
                    text_: text,
                    parentRenderData_: parentRenderData,
                    rootRenderData_: rootRenderData,
                });
            } while (text);
        }
    });
};

const addlineBrBr = ({
    text_,
    parentRenderData_,
}: {
    text_: string;
    parentRenderData_: ParentRenderData;
}) => {
    if (text_.startsWith("\n\n")) {
        const uuid = nanoid8();
        const lineBrBr: RenderData = {
            htmlType_: MarkdownType.LineBrBr,
            text_: "\n\n",
            uuid_: uuid,
            mdSymbols_: [],
            htmlProps_: {},
        };
        parentRenderData_.children_.push(lineBrBr);
        if (text_ === "\n\n") {
            const [emptyP] = createEmptyP(false);
            parentRenderData_.children_.push(emptyP);
        }
        return text_.slice(2);
    }
    return text_;
};
