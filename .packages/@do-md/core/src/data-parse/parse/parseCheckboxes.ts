import { nanoid8 } from "@do-md/utils";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
    CheckedTextRef,
} from "../../editor/type";
import { MarkdownType } from "../../editor/type/enum";
import { parseBlock } from "./parseBlock";
import { DATA_ATOMIC_RENDER_ID, DATA_RENDER_ID } from "../constant";
import { createLiParent } from "../create-render-data/createLiParent";

export const parseCheckboxes = (
    text: string,
    rootRenderData: RootRenderData,
): ParentRenderData => {
    if (!text) throw Error("text is not a valid unordered list");
    const lineUUID = nanoid8();

    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.CheckBoxUl,
        children_: [],
        uuid_: lineUUID,
        mdSymbols_: [],
        htmlProps_: {
            [DATA_RENDER_ID]: lineUUID,
            [DATA_ATOMIC_RENDER_ID]: lineUUID,
        },
    };

    const liTexts = getFirstLevelCheckboxesList(text);

    parseLines({
        liTexts,
        parentRenderData: lineRenderData,
        rootRenderData,
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
    liTexts.forEach((liText) => {
        const symbol = liText.match(/^(\s*)-\s\[[ xX]\]\s/)?.[0];
        if (!symbol) throw Error("Invalid checkbox");
        const mdSymbolId = nanoid8();

        const liChildren = liText.split("\n");
        const firstLine = liChildren.shift()?.slice(symbol.length) || "";
        let newLiText = liChildren.map((c) => c.slice(2)).join("\n");

        const id = nanoid8();
        const liParent = createLiParent(id, mdSymbolId);

        const inputParent: RenderData = {
            htmlType_: MarkdownType.CheckboxesInput,
            text_: "",
            uuid_: nanoid8(),
            mdSymbols_: [mdSymbolId],
            htmlProps_: {
                checked: !!symbol.match(/^- \[x\] .*/gm),
            },
        };

        liParent.children_.push(inputParent);

        parentRenderData.children_.push(liParent);

        parseBlock({
            text_: firstLine,
            parentRenderData_: liParent,
            rootRenderData_: rootRenderData,
        });
        while (newLiText) {
            newLiText = parseBlock({
                text_: newLiText,
                parentRenderData_: liParent,
                rootRenderData_: rootRenderData,
            });
        }
    });
};

function getFirstLevelCheckboxesList(markdown: string) {
    const lines = markdown.split("\n"); // Split Markdown by lines
    const result: string[] = [];
    let currentBlock: string | null = null; // Current block being collected
    let isInCodeBlock = false; // Whether inside a code block

    lines.forEach((line) => {
        // Detect code block start and end
        if (line.trim().startsWith("```")) {
            isInCodeBlock = !isInCodeBlock;
        }

        // Check if it's a top-level checkbox (e.g., "- [ ]" or "- [x]")
        const isTopLevelCheckbox =
            !isInCodeBlock && line.match(/^-\s\[[ xX]\]\s/);

        if (isTopLevelCheckbox) {
            // If it's a new top-level checkbox, save the current block
            if (currentBlock !== null) {
                result.push(currentBlock.trimEnd());
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
        result.push((currentBlock as string).trimEnd());
    }

    return result;
}
