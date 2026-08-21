import { MarkdownType } from "../../editor/type/enum";
import { parseInline } from "./parseInline";
import {
    CursorInfo,
    ParentRenderData,
    RootRenderData,
} from "../../editor/type";
import { nanoid8 } from "@do-md/utils";
import { CursorMarker } from "../../editor/constant";
import { getHeaderAreaText } from "../gettext/getHeaderAreaText";
import { getCodeAreaText } from "../gettext/getCodeAreaText";
import { getParseContext } from "../parseMarkdown";
import { getULAreaText } from "../gettext/getULAreaText";
import { getBlockquoteAreaText } from "../gettext/getBlockquoteAreaText";
import { extractTableText } from "../gettext/extractTableText";
import { OL_LINE_REG } from "../reg";
import { getOLAreaText } from "../gettext/getOLAreaText";
import { parseBlock } from "./parseBlock";
import { createEmptyP } from "../create-render-data/createEmptyP";
import { createParentRenderData } from "../create-render-data/createParentRenderData";
import { DATA_RENDER_ID } from "../constant";
import { createTextRenderData } from "../create-render-data/createTextRenderData";
import { wrapImgGroups } from "./wrapImgGroups";

export const parseP = ({
    text_,
    parentRenderData_,
    rootRenderData_,
}: {
    text_: string;
    parentRenderData_: ParentRenderData;
    rootRenderData_: RootRenderData;
}) => {
    const { onCursorFound_ } = getParseContext();
    const lines = text_.split("\n");
    if (lines.length === 1) {
        parseActualP({
            text: text_,
            parentRenderData: parentRenderData_,
            onCursorFound: onCursorFound_,
        });
        return;
    }

    const pLines = [];
    let otherText = "";
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("#") || line.startsWith(CursorMarker + "#")) {
            const headerText = getHeaderAreaText(line);

            if (headerText) {
                break;
            }
        } else if (line.startsWith("```")) {
            const codeText = getCodeAreaText(line);
            if (codeText) {
                break;
            }
        } else if (
            line.startsWith("- ") ||
            line === "- " ||
            line.startsWith("* ") ||
            line === "* " ||
            line.startsWith("+ ") ||
            line === "+ "
        ) {
            const ulText = getULAreaText(line);

            if (ulText) {
                break;
            }
        } else if (line.startsWith("> ")) {
            const blockquoteText = getBlockquoteAreaText(line);

            if (blockquoteText) {
                break;
            }
        } else if (OL_LINE_REG.test(line)) {
            const olText = getOLAreaText(line);

            if (olText) {
                break;
            }
        } else if (
            line.startsWith("|") &&
            extractTableText(lines.slice(i).join("\n"))
        ) {
            // Tight paragraph→table seam (GFM). Heading/list already break here.
            break;
        } else {
            pLines.push(line);
        }
    }

    const pText = pLines.join("\n");

    otherText = text_.slice(pText.length);

    parseActualP({
        text: pText,
        parentRenderData: parentRenderData_,
        onCursorFound: onCursorFound_,
    });

    if (otherText) {
        parentRenderData_.children_.push({
            htmlType_: MarkdownType.LineBr,
            text_: "\n",
            uuid_: nanoid8(),
            mdSymbols_: [],
            htmlProps_: {},
        });
        let remaining = otherText.slice(1);
        while (remaining) {
            remaining = parseBlock({
                text_: remaining,
                parentRenderData_: parentRenderData_,
                rootRenderData_: rootRenderData_,
            });
        }
    }
};

export const parseActualP = ({
    text,
    parentRenderData,
    onCursorFound,
}: {
    text: string;
    parentRenderData: ParentRenderData;
    onCursorFound?: (cursorInfo: CursorInfo) => void;
}) => {
    // Strip every CursorMarker, recording each position in the progressively
    // stripped text. A caret op leaves one marker; an inline-format op leaves
    // two (selection start + end). onCursorFound fires once per marker so the
    // store can map the first to the selection start and the second to its end.
    const cursorOffsets: number[] = [];
    {
        let idx = text.indexOf(CursorMarker);
        while (idx !== -1) {
            cursorOffsets.push(idx);
            text = text.slice(0, idx) + text.slice(idx + CursorMarker.length);
            idx = text.indexOf(CursorMarker);
        }
    }
    const id = nanoid8();
    const lineRenderData: ParentRenderData = text
        ? createParentRenderData({
              htmlType_: MarkdownType.P,
              uuid_: id,
              htmlProps_: {
                  [DATA_RENDER_ID]: id,
              },
          })
        : createEmptyP()[0];

    cursorOffsets.forEach((offset_) =>
        onCursorFound?.({
            uuid: lineRenderData.uuid_,
            offset: offset_,
        }),
    );

    const remainingLineText = parseInline({
        parseText_: text,
        renderData_: lineRenderData,
    });

    if (remainingLineText) {
        lineRenderData.children_.push(
            createTextRenderData({ text_: remainingLineText }),
        );
    }

    // Image-group aggregation (opt-in): a P's children take their final
    // shape here, and every reparse path funnels through this point — one
    // mount site covers all text→tree seams. CursorMarker was already
    // stripped at the entry of this function, so the separator-text test
    // never runs into a marker.
    const { imgGroupSeparators_ } = getParseContext();
    if (imgGroupSeparators_ !== undefined) {
        wrapImgGroups(lineRenderData, imgGroupSeparators_);
    }

    parentRenderData.children_.push(lineRenderData);
};
