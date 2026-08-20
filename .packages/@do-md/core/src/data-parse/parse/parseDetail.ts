import { CheckedTextRef } from "../../editor/type";
import { MarkdownType } from "../../editor/type/enum";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
} from "../../editor/type";
import { parseBlock } from "./parseBlock";
import { nanoid8 } from "@do-md/utils";
import { getParseContext } from "../parseMarkdown";

const DetailStart = `<details>`;
const DetailOpenStart = `<details open>`;
const DetailEnd = `</details>`;
const SummaryStart = `<summary>`;
const SummaryEnd = `</summary>`;

export const parseDetail = ({
    summaryText_,
    contentText_,
    isOpen_,
    parentRenderData_,
    rootRenderData_,
}: {
    summaryText_: string;
    contentText_: string;
    isOpen_: boolean;
    parentRenderData_: ParentRenderData;
    rootRenderData_: RootRenderData;
}) => {
    const { onCursorFound_: onCursorFound } = getParseContext();
    const lineRenderData: ParentRenderData = {
        htmlType_: MarkdownType.Detail,
        children_: [],
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {
            open: isOpen_,
        },
    };

    const detailStart = isOpen_ ? DetailOpenStart : DetailStart;

    const hideDetailStart: RenderData = {
        htmlType_: MarkdownType.HideSecondLine,
        text_: `${detailStart}\n`,
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    lineRenderData.children_.push(hideDetailStart);

    const hideSummaryStart: RenderData = {
        htmlType_: MarkdownType.HideSecondLine,
        text_: SummaryStart,
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    lineRenderData.children_.push(hideSummaryStart);

    const summary: ParentRenderData = {
        htmlType_: MarkdownType.Summary,
        children_: [],
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    do {
        const checkedTextRef: CheckedTextRef = {
            current: 0,
        };
        summaryText_ = parseBlock({
            text_: summaryText_,
            parentRenderData_: summary,
            rootRenderData_: rootRenderData_,
        });
    } while (summaryText_);

    lineRenderData.children_.push(summary);

    const hideSummaryEnd: RenderData = {
        htmlType_: MarkdownType.HideSecondLine,
        text_: SummaryEnd,
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    lineRenderData.children_.push(hideSummaryEnd);

    do {
        const checkedTextRef: CheckedTextRef = {
            current: 0,
        };
        contentText_ = parseBlock({
            text_: contentText_,
            parentRenderData_: lineRenderData,
            rootRenderData_: rootRenderData_,
        });
    } while (contentText_);

    const hideData: RenderData = {
        htmlType_: MarkdownType.HideSecondLine,
        text_: "\n\n",
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };
    lineRenderData.children_.push(hideData);

    const hideDetailEnd: RenderData = {
        htmlType_: MarkdownType.HideSecondLine,
        text_: DetailEnd,
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };
    lineRenderData.children_.push(hideDetailEnd);

    parentRenderData_.children_.push(lineRenderData);
};
