import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    Token,
} from "../../editor/type";
import { CursorMarker, ZeroWidthSpace } from "../../editor/constant";
import { getParseContext } from "../parseMarkdown";
import { DATA_ATOMIC_RENDER_ID, DATA_RENDER_ID } from "../constant";
import { createHideSecondLine } from "../create-render-data/createHideSecondLine";
import { createTextRenderData } from "../create-render-data/createTextRenderData";

export type ParseCodeProps = {
    text_: string;
};

/**
 * Code text → list of code spans. When no tokenizer is supplied, or the
 * tokenizer returns an empty token stream for non-empty code (language not
 * supported / grammar not loaded, e.g. mermaid or jsonc), fall back to a
 * single plain-text span — the language marking is unaffected (the fence
 * line text and the Pre's `language-xxx` className stay as they are).
 */
const tokenizeCode = (
    codeText: string,
    language: string,
    codeTokenizer?: (code: string, lang?: string) => Token[],
): RenderData[] => {
    if (codeTokenizer) {
        const parsed = parseCodeToken(
            codeTokenizer(codeText, language || "plain"),
        );
        if (parsed.length || !codeText.length) return parsed;
    }
    return [
        createTextRenderData({
            htmlType_: MarkdownType.CodeSpanText,
            text_: codeText,
        }),
    ];
};

export function parseCode({ text_ }: ParseCodeProps) {
    if (!text_) throw Error("text is not a valid unordered list");
    const { onCursorFound_: onCursorFound, codeTokenizer_: codeTokenizer } =
        getParseContext();
    const cursorIndex = text_.indexOf(CursorMarker);
    const lineUUID = nanoid8();

    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.Pre,
        children_: [],
        uuid_: lineUUID,
        mdSymbols_: [],
        htmlProps_: {
            [DATA_RENDER_ID]: lineUUID,
            [DATA_ATOMIC_RENDER_ID]: lineUUID,
        },
    };

    // if (text_.endsWith(CursorMarker)) {
    //     text_ = text_.slice(0, -1);
    //     onCursorFound?.({
    //         uuid_: lineUUID,
    //         offset_: text_.length - 3,
    //     });
    // } else if (cursorIndex !== -1) {
    //     onCursorFound?.({
    //         uuid_: lineUUID,
    //         offset_: cursorIndex,
    //     });
    // }

    if (cursorIndex !== -1) {
        onCursorFound?.({
            uuid: lineUUID,
            offset: cursorIndex,
        });
    }

    const secondLineTexts = text_.split("\n");
    const symbolFirst = secondLineTexts.shift()?.replace(CursorMarker, "");
    if (!symbolFirst) throw Error("Invalid code");
    const symbolFirstId = nanoid8();
    const language = symbolFirst.replace("```", "").trim();

    if (
        secondLineTexts.length &&
        (secondLineTexts[secondLineTexts.length - 1] === "```" ||
            secondLineTexts[secondLineTexts.length - 1] ===
                `\`\`\`${CursorMarker}`)
    ) {
        lineRenderData.htmlType_ = MarkdownType.Pre;
        if (language) {
            lineRenderData.htmlProps_.className = `language-${language}`;
        } else {
            lineRenderData.htmlProps_.className = `language-plain`;
        }
        const symbolEnd = secondLineTexts.pop();

        let codeText = secondLineTexts
            .map((text) => {
                return text === ZeroWidthSpace ||
                    text === `${CursorMarker}${ZeroWidthSpace}`
                    ? text
                    : text.replaceAll(ZeroWidthSpace, "");
            })
            .join("\n");

        const cursorIndex = codeText.indexOf(CursorMarker);

        if (cursorIndex !== -1) {
            codeText =
                codeText.slice(0, cursorIndex) +
                codeText.slice(cursorIndex + CursorMarker.length);
        }

        const symbolEndId = nanoid8();

        const parsedCode = tokenizeCode(codeText, language, codeTokenizer);

        const symbolFirstRender: RenderData = {
            htmlType_: MarkdownType.MdHideSymbol,
            text_: symbolFirst,
            uuid_: symbolFirstId,
            mdSymbols_: [symbolFirstId, symbolEndId],
            htmlProps_: {},
        };

        const hideSecondLine1 = createHideSecondLine();

        const symbolEndRender: RenderData = {
            htmlType_: MarkdownType.MdHideSymbol,
            text_: symbolEnd || "",
            uuid_: symbolEndId,
            mdSymbols_: [symbolFirstId, symbolEndId],
            htmlProps_: {},
        };

        const hideSecondLine2 = createHideSecondLine();

        const codeRenderUUID = nanoid8();
        const codeRender: ParentRenderData = {
            htmlType_: codeText.length
                ? MarkdownType.PreCode
                : MarkdownType.PreCodeEmpty,
            children_: [],
            uuid_: codeRenderUUID,
            mdSymbols_: [symbolFirstId, symbolEndId],
            htmlProps_: {
                [DATA_RENDER_ID]: codeRenderUUID,
                // className: language ? `language-${language}` : '',
            },
        };

        codeRender.children_.push(...parsedCode);

        if (cursorIndex !== -1) {
            onCursorFound?.({
                uuid: codeRender.uuid_,
                offset: cursorIndex,
            });
        }

        lineRenderData.children_.push(
            symbolFirstRender,
            hideSecondLine1,
            codeRender,
            hideSecondLine2,
            symbolEndRender,
        );
    } else if (secondLineTexts.length) {
        lineRenderData.htmlType_ = MarkdownType.Pre;
        if (language) {
            lineRenderData.htmlProps_.className = `language-${language}`;
        } else {
            lineRenderData.htmlProps_.className = `language-plain`;
        }

        let codeText = secondLineTexts
            .map((text) => {
                return text === ZeroWidthSpace ||
                    text === `${CursorMarker}${ZeroWidthSpace}`
                    ? text
                    : text.replaceAll(ZeroWidthSpace, "");
            })
            .join("\n");

        const cursorIndex = codeText.indexOf(CursorMarker);

        if (cursorIndex !== -1) {
            codeText =
                codeText.slice(0, cursorIndex) +
                codeText.slice(cursorIndex + CursorMarker.length);
        }

        const symbolEndId = nanoid8();

        const parsedCode = tokenizeCode(codeText, language, codeTokenizer);

        const symbolFirstRender: RenderData = {
            htmlType_: MarkdownType.MdHideSymbol,
            text_: symbolFirst,
            uuid_: symbolFirstId,
            mdSymbols_: [symbolFirstId, symbolEndId],
            htmlProps_: {},
        };

        const hideSecondLine1 = createHideSecondLine();

        const hideSecondLine2 = createHideSecondLine(true);

        const codeRenderUUID = nanoid8();
        const codeRender: ParentRenderData = {
            htmlType_: codeText.length
                ? MarkdownType.PreCode
                : MarkdownType.PreCodeEmpty,
            children_: [],
            uuid_: codeRenderUUID,
            mdSymbols_: [symbolFirstId, symbolEndId],
            htmlProps_: {
                [DATA_RENDER_ID]: codeRenderUUID,
                // className: language ? `language-${language}` : '',
            },
        };

        codeRender.children_.push(...parsedCode);

        if (cursorIndex !== -1) {
            onCursorFound?.({
                uuid: codeRender.uuid_,
                offset: cursorIndex,
            });
        }

        const symbolEndRender: RenderData = {
            htmlType_: MarkdownType.MdHideSymbol,
            text_: "```",
            uuid_: symbolEndId,
            isAutoFill_: true,
            mdSymbols_: [symbolFirstId, symbolEndId],
            htmlProps_: {},
        };

        lineRenderData.children_.push(
            symbolFirstRender,
            hideSecondLine1,
            codeRender,
            hideSecondLine2,
            symbolEndRender,
        );
    } else {
        lineRenderData.htmlType_ = MarkdownType.PreEmpty;
        lineRenderData.htmlProps_[DATA_RENDER_ID] = lineUUID;
        const symbolFirstRender: RenderData = {
            htmlType_: MarkdownType.Plain,
            text_: symbolFirst,
            uuid_: symbolFirstId,
            mdSymbols_: [symbolFirstId],
            htmlProps_: {},
        };
        lineRenderData.children_.push(symbolFirstRender);
    }

    return lineRenderData;
}

export const TokenTypeMap = {
    "template-string": MarkdownType.CodeSpanCdata,
    parameter: MarkdownType.CodeSpanKeyword, // Note: This is a simplification, as 'parameter' can map to multiple types
    "block-comment": MarkdownType.CodeSpanBlockComment,
    cdata: MarkdownType.CodeSpanCdata,
    comment: MarkdownType.CodeSpanComment,
    doctype: MarkdownType.CodeSpanDoctype,
    prolog: MarkdownType.CodeSpanProlog,
    punctuation: MarkdownType.CodeSpanPunctuation,
    "attr-name": MarkdownType.CodeSpanAttrName,
    deleted: MarkdownType.CodeSpanDeleted,
    namespace: MarkdownType.CodeSpanNamespace,
    tag: MarkdownType.CodeSpanTag,
    "function-name": MarkdownType.CodeSpanFunctionName,
    boolean: MarkdownType.CodeSpanBoolean,
    function: MarkdownType.CodeSpanFunction,
    number: MarkdownType.CodeSpanNumber,
    "class-name": MarkdownType.CodeSpanClassName,
    constant: MarkdownType.CodeSpanConst,
    property: MarkdownType.CodeSpanProperty,
    symbol: MarkdownType.CodeSpanSymbol,
    atrule: MarkdownType.CodeSpanAtrule,
    builtin: MarkdownType.CodeSpanBuiltin,
    important: MarkdownType.CodeSpanImportant,
    keyword: MarkdownType.CodeSpanKeyword,
    selector: MarkdownType.CodeSpanSelector,
    "attr-value": MarkdownType.CodeSpanAttrValue,
    char: MarkdownType.CodeSpanChar,
    regex: MarkdownType.CodeSpanRegex,
    string: MarkdownType.CodeSpanString,
    variable: MarkdownType.CodeSpanVariable,
    entity: MarkdownType.CodeSpanEntity,
    operator: MarkdownType.CodeSpanOperator,
    url: MarkdownType.CodeSpanUrl,
    bold: MarkdownType.CodeSpanBold,
    italic: MarkdownType.CodeSpanItalic,
    inserted: MarkdownType.CodeSpanInserted,
};

export const parseCodeToken = (
    tokens: Token[],
    children: RenderData[] = [],
): RenderData[] => {
    tokens.forEach((token) => {
        if (token === "\n\n") {
            children.push(
                createTextRenderData({
                    htmlType_: MarkdownType.CodeSpanText,
                    text_: "\n",
                }),
                createTextRenderData({
                    htmlType_: MarkdownType.CodeSpanText,
                    text_: "\n",
                }),
            );
        } else {
            const renderData: RenderData = createTextRenderData({
                htmlType_:
                    typeof token === "string"
                        ? MarkdownType.CodeSpanText
                        : TokenTypeMap[
                              token.type as keyof typeof TokenTypeMap
                          ] || MarkdownType.CodeSpanText,
                text_:
                    typeof token === "string"
                        ? token
                        : getTokenContent(token.content),
            });

            if (typeof token === "string") {
                children.push(renderData);
            } else if (Array.isArray(token.content)) {
                parseCodeToken(token.content, children);
            } else {
                children.push(renderData);
            }
        }
    });
    return children;
};

const getTokenContent = (token: string | Token[]): string => {
    let result = "";

    const get = (token: string | Token[]) => {
        if (typeof token === "string") {
            result += token;
        } else {
            token.forEach((parameterToken) => {
                if (typeof parameterToken === "string") {
                    result += parameterToken;
                } else if (typeof parameterToken.content === "string") {
                    result += parameterToken.content;
                } else {
                    get(parameterToken.content);
                }
            });
        }
    };

    get(token);

    return result;
};
