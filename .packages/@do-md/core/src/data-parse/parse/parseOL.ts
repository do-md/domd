import { nanoid8 } from "@do-md/utils";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
} from "../../editor/type";
import { MarkdownType } from "../../editor/type/enum";
import { parseBlock } from "./parseBlock";
import { CursorMarker } from "../../editor/constant";
import { DATA_ATOMIC_RENDER_ID, DATA_RENDER_ID } from "../constant";
import { createTextRenderData } from "../create-render-data/createTextRenderData";

const TRAILING_AUTOFILL_RE = new RegExp(`^ *(?:\\d+\\.? ?)?${CursorMarker}$`);

export const parseOL = (
    text_: string,
    rootRenderData_: RootRenderData,
    isTopLevel_: boolean = true,
): ParentRenderData => {
    if (!text_) throw Error("text is not a valid unordered list");

    const lineUUID = nanoid8();
    const startNumber = parseInt(text_, 10);

    const htmlProps: Record<string, any> = {
        start: startNumber,
        [DATA_RENDER_ID]: lineUUID,
    };
    if (isTopLevel_) {
        htmlProps[DATA_ATOMIC_RENDER_ID] = lineUUID;
    }

    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.Ol,
        children_: [],
        uuid_: lineUUID,
        mdSymbols_: [],
        htmlProps_: htmlProps,
    };

    const liTexts = getFirstLevelLiBlocksForOrdered(text_);

    parseLines({
        liTexts,
        parentRenderData: lineRenderData,
        rootRenderData: rootRenderData_,
    });

    return lineRenderData;
};

const parseLines = ({
    liTexts,
    parentRenderData,
    rootRenderData,
}: {
    liTexts: string[];
    parentRenderData: ParentRenderData;
    rootRenderData: RootRenderData;
}) => {
    liTexts.forEach((liText, index) => {
        const symbol = liText.match(/^(\s*\d+\.\s?)/)?.[0];
        if (!symbol) throw Error("Invalid ordered list");
        const mdSymbolId = nanoid8();

        const liChildren = liText.split("\n");
        const firstLine = liChildren.shift()?.slice(symbol.length) || "";

        let hasAutofill = false;
        let autofillPrefix = "";
        if (index === liTexts.length - 1) {
            const lastLine = liChildren[liChildren.length - 1];
            if (
                typeof lastLine === "string" &&
                lastLine.endsWith(CursorMarker) &&
                TRAILING_AUTOFILL_RE.test(lastLine)
            ) {
                autofillPrefix = lastLine.slice(0, -CursorMarker.length);
                liChildren.pop();
                hasAutofill = true;
            }
        }

        let newLiText = liChildren
            .map((c) => c.slice(symbol.length))
            .join("\n");
        if (newLiText.startsWith("\n")) {
            newLiText = newLiText.slice(1);
        }

        const id = nanoid8();

        const liParent: ParentRenderData = {
            htmlType_: MarkdownType.li,
            children_: [],
            uuid_: id,
            mdSymbols_: [mdSymbolId],
            htmlProps_: {
                [DATA_RENDER_ID]: id,
            },
        };

        parentRenderData.children_.push(liParent);

        if (index !== liTexts.length - 1) {
            const lineBr: RenderData = createTextRenderData({
                htmlType_: MarkdownType.LineBr,
                text_: "\n",
            });
            parentRenderData.children_.push(lineBr);
        }

        parseBlock({
            text_: firstLine,
            parentRenderData_: liParent,
            rootRenderData_: rootRenderData,
        });
        while (newLiText) {
            const lineBr: RenderData = {
                htmlType_: MarkdownType.LineBr,
                text_: "\n",
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {},
            };
            liParent.children_.push(lineBr);
            newLiText = parseBlock({
                text_: newLiText,
                parentRenderData_: liParent,
                rootRenderData_: rootRenderData,
            });
            if (newLiText.startsWith("\n")) {
                newLiText = newLiText.slice(1);
            }
        }

        if (hasAutofill) {
            parentRenderData.children_.push({
                htmlType_: MarkdownType.LineBr,
                text_: "\n" + autofillPrefix,
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {},
            });
            const autoFillId = nanoid8();
            const autoFillLi: ParentRenderData = {
                htmlType_: MarkdownType.li,
                children_: [],
                uuid_: autoFillId,
                mdSymbols_: [mdSymbolId],
                isAutoFill_: true,
                htmlProps_: {
                    [DATA_RENDER_ID]: autoFillId,
                },
            };
            parentRenderData.children_.push(autoFillLi);
            parseBlock({
                text_: autofillPrefix + CursorMarker,
                parentRenderData_: autoFillLi,
                rootRenderData_: rootRenderData,
            });
        }
    });
};

function getFirstLevelLiBlocksForOrdered(markdown: string) {
    const lines = markdown.split("\n"); // Split Markdown by lines
    const result: string[] = [];
    let currentBlock: string | null = null; // Current block being collected
    let isInCodeBlock = false; // Whether inside a code block

    lines.forEach((line) => {
        // Detect code block start and end
        if (line.trim().startsWith("```")) {
            isInCodeBlock = !isInCodeBlock;
        }

        // Check if it's a top-level ordered list item (e.g., "1. ", "2. ")
        const isTopLevelLi = !isInCodeBlock && line.match(/^\d+\.\s+/);

        if (isTopLevelLi) {
            // If it's a new top-level li, save the current block
            if (currentBlock !== null) {
                result.push(currentBlock.trim());
            }
            // Start a new block
            currentBlock = line;
        } else if (currentBlock !== null) {
            // Otherwise, add content to the current block
            currentBlock += `\n${line}`;
        }
    });

    // Add the last block
    if (currentBlock !== null) {
        result.push((currentBlock as string).trim());
    }

    return result;
}
