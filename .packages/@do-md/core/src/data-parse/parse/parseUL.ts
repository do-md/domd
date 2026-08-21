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

export const parseUL = (
    text_: string,
    rootRenderData_: RootRenderData,
    isTopLevel_: boolean = true,
): ParentRenderData => {
    if (!text_) throw Error("text is not a valid unordered list");

    const lineUUID = nanoid8();

    const htmlProps: Record<string, any> = {
        [DATA_RENDER_ID]: lineUUID,
    };
    if (isTopLevel_) {
        htmlProps[DATA_ATOMIC_RENDER_ID] = lineUUID;
    }

    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.Ul,
        children_: [],
        uuid_: lineUUID,
        mdSymbols_: [],
        htmlProps_: htmlProps,
    };
    const liTexts = getFirstLevelLiBlocks(text_);
    const mark = liTexts[0]?.[0] || "";
    lineRenderData.htmlProps_["data-mark"] = mark;

    parseLines({
        liTexts,
        parentRenderData: lineRenderData,
        rootRenderData: rootRenderData_,
    });

    return lineRenderData;
};

function getFirstLevelLiBlocks(markdown: string): string[] {
    const lines = markdown.split("\n"); // Split Markdown by lines
    const result: string[] = [];
    let currentBlock: string | null = null; // Current block being collected
    let isInCodeBlock = false; // Whether inside a code block

    lines.forEach((line) => {
        // Detect code block start and end
        if (line.trim().startsWith("```")) {
            isInCodeBlock = !isInCodeBlock;
        }

        // Check if it's a top-level li
        const isTopLevelLi = !isInCodeBlock && line.match(/^[-*+]\s+/);

        if (isTopLevelLi) {
            // If it's a new top-level li, save the current block
            if (currentBlock !== null) {
                result.push(trimBlockEnd(currentBlock));
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
        result.push(trimBlockEnd(currentBlock as string));
    }

    return result;
}

/**
 * Drop the blank lines a block collects at its end, and nothing else.
 *
 * A plain `.trim()` here also ate the trailing spaces of the block's last
 * content line, which are significant markdown: two of them are a hard line
 * break, and one of them is the entire body of an empty to-do marker
 * (`- [ ] `). Losing that one space downgrades an empty item to a bullet
 * whose text is the literal `[ ]` — and since `- [ ] ` is what this kernel's
 * own serializer emits for an empty item, the round trip broke on its own
 * output. Every other block parser keeps trailing spaces verbatim; this is
 * the list splitter catching up with them.
 */
function trimBlockEnd(block: string): string {
    return block.replace(/\n\s*$/, "");
}

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
        const symbol = liText.slice(0, 2);
        const mdSymbolId = nanoid8();

        const liChildren = liText.split("\n");
        let firstLine = liChildren.shift()?.slice(symbol.length) || "";

        let hasAutofill = false;
        let autofillPrefix = "";
        if (index === liTexts.length - 1) {
            const lastLine = liChildren[liChildren.length - 1];
            if (
                typeof lastLine === "string" &&
                lastLine.endsWith(CursorMarker) &&
                /^ *(?:[-+*] ?)?$/.test(lastLine.slice(0, -CursorMarker.length))
            ) {
                autofillPrefix = lastLine.slice(0, -CursorMarker.length);
                liChildren.pop();
                hasAutofill = true;
            }
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

        if (firstLine.startsWith("[ ] ") || firstLine.startsWith("[x] ")) {
            liParent.htmlType_ = MarkdownType.CheckBoxLi;
            liParent.children_.push({
                htmlType_: MarkdownType.CheckBoxLabel,
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {
                    contentEditable: false,
                },
                children_: [
                    {
                        htmlType_: MarkdownType.CheckboxesInput,
                        text_: "",
                        uuid_: nanoid8(),
                        mdSymbols_: [],
                        htmlProps_: {
                            checked: firstLine.startsWith("[x] "),
                        },
                    },
                    {
                        htmlType_: MarkdownType.Plain,
                        text_: "",
                        uuid_: nanoid8(),
                        mdSymbols_: [],
                        htmlProps_: {},
                    },
                ],
            });
            firstLine = firstLine.slice(4);
        }

        parentRenderData.children_.push(liParent);

        let newLiText = liChildren
            .map((c) => {
                return c.slice(2);
            })
            .join("\n");
        if (newLiText.startsWith("\n")) {
            newLiText = newLiText.slice(1);
        }

        if (index !== liTexts.length - 1) {
            const lineBr: RenderData = {
                htmlType_: MarkdownType.LineBr,
                text_: "\n",
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {},
            };
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
