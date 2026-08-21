import { nanoid8 } from "@do-md/utils";
import { ParentRenderData, RootRenderData } from "../../editor/type";
import { MarkdownType } from "../../editor/type/enum";
import { parseBlock } from "./parseBlock";
import { CursorMarker } from "../../editor/constant";
import { DATA_ATOMIC_RENDER_ID, DATA_RENDER_ID } from "../constant";

const TRAILING_AUTOFILL_RE = new RegExp(`^>? ?${CursorMarker}$`);
const EMPTY_QUOTE_LINE_RE = /^>\s*$/;

export const parseBlockquote = (
    text: string,
    rootRenderData: RootRenderData,
    isTopLevel_: boolean = true,
): ParentRenderData => {
    if (!text) throw Error("text is not a valid blockquote");
    const lineUUID = nanoid8();

    const htmlProps: Record<string, any> = {
        [DATA_RENDER_ID]: lineUUID,
    };
    if (isTopLevel_) {
        htmlProps[DATA_ATOMIC_RENDER_ID] = lineUUID;
    }

    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.Blockquote,
        children_: [],
        uuid_: lineUUID,
        mdSymbols_: [],
        htmlProps_: htmlProps,
    };

    const lines = text.split("\n");
    let hasAutofill = false;
    let autofillRaw = "";
    let bodyText = text;

    // Streaming autofill: last line is whitespace/partial `>` marker + cursor.
    // Only triggers when there's already at least one committed quote line
    // above, otherwise `"> <Cursor>"` would be misread as autofill instead of
    // a fresh empty blockquote.
    if (lines.length >= 2) {
        const lastLine = lines[lines.length - 1];
        if (
            typeof lastLine === "string" &&
            lastLine.endsWith(CursorMarker) &&
            TRAILING_AUTOFILL_RE.test(lastLine)
        ) {
            let startIdx = lines.length - 1;
            // Pure `>` lines immediately above the cursor line are part of the
            // unresolved paragraph-break region — pull them into the autofill
            // raw so the round-trip preserves them verbatim.
            while (
                startIdx > 0 &&
                EMPTY_QUOTE_LINE_RE.test(lines[startIdx - 1])
            ) {
                startIdx -= 1;
            }
            autofillRaw = lines
                .slice(startIdx)
                .join("\n")
                .slice(0, -CursorMarker.length);
            bodyText = lines.slice(0, startIdx).join("\n");
            hasAutofill = true;
        }
    }

    if (bodyText) {
        const blockTexts = getFirstLevelBlocks(bodyText);
        blockTexts.forEach((blockText, idx) => {
            const innerText = blockText
                .split("\n")
                .map((c) => c.slice(2))
                .join("\n");

            // `do…while`, not `while`: an empty body (`> ` with nothing after
            // it) still has to parse one block, so the quote gets the empty
            // paragraph that makes it editable. A plain `while` skips the body
            // entirely and leaves the Blockquote childless, which serializes
            // to "" — the quote silently evaporates from the document. Same
            // loop shape as the document-level one in parseMarkdown.
            let remaining = innerText;
            do {
                remaining = parseBlock({
                    text_: remaining,
                    parentRenderData_: lineRenderData,
                    rootRenderData_: rootRenderData,
                });
            } while (remaining);

            if (idx !== blockTexts.length - 1) {
                lineRenderData.children_.push({
                    htmlType_: MarkdownType.LineBr,
                    text_: "\n>\n",
                    uuid_: nanoid8(),
                    mdSymbols_: [],
                    htmlProps_: {},
                });
            }
        });
    }

    if (hasAutofill) {
        lineRenderData.children_.push({
            htmlType_: MarkdownType.LineBr,
            text_: (bodyText ? "\n" : "") + autofillRaw,
            uuid_: nanoid8(),
            mdSymbols_: [],
            htmlProps_: {},
        });
        const autoFillId = nanoid8();
        const autoFillP: ParentRenderData = {
            htmlType_: MarkdownType.P,
            children_: [],
            uuid_: autoFillId,
            mdSymbols_: [],
            isAutoFill_: true,
            htmlProps_: {
                [DATA_RENDER_ID]: autoFillId,
            },
        };
        lineRenderData.children_.push(autoFillP);
        parseBlock({
            text_: CursorMarker,
            parentRenderData_: autoFillP,
            rootRenderData_: rootRenderData,
        });
    }

    return lineRenderData;
};

function getFirstLevelBlocks(markdown: string): string[] {
    return markdown.split("\n>\n");
}
