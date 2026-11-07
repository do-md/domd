import { nanoid8 } from "@do-md/utils";
import { ParentRenderData } from "../../editor/type";
import { MarkdownType } from "../../editor/type/enum";
import { parseActualP } from "./parseP";
import { CursorMarker } from "../../editor/constant";
import { DATA_ATOMIC_RENDER_ID, DATA_RENDER_ID } from "../constant";
import { getParseContext } from "../parseMarkdown";

/**
 * A cell's content: one inline paragraph, whatever its text holds. GFM cells
 * are inline only — a cell starting with `# ` or `- ` is text, not a heading
 * or a list — and a cell line break (`<br>`) becomes a "\n" in the model
 * (data-parse/hardBreak.ts). The single cell parser: parseTable uses it for
 * every cell, and parseTableCellMarkdown for an edit's reparse of one cell.
 */
export const parseTableCell = (text: string, cell: ParentRenderData) => {
    parseActualP({
        text,
        parentRenderData: cell,
        onCursorFound: getParseContext().onCursorFound_,
        tableCell: true,
    });
};

export function parseTable({ text_ }: { text_: string }): ParentRenderData {
    if (!text_) throw Error("text is not a valid unordered list");
    const lineUUID = nanoid8();

    const tableData: ParentRenderData = {
        htmlType_: MarkdownType.Table,
        children_: [],
        uuid_: lineUUID,
        mdSymbols_: [],
        htmlProps_: {
            [DATA_RENDER_ID]: lineUUID,
            [DATA_ATOMIC_RENDER_ID]: lineUUID,
            // contentEditable: false
        },
    };

    const headerData: ParentRenderData = {
        htmlType_: MarkdownType.THead,
        children_: [],
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    tableData.children_.push(headerData);

    const headerTRData: ParentRenderData = {
        htmlType_: MarkdownType.TR,
        children_: [],
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    headerData.children_.push(headerTRData);

    const bodyData: ParentRenderData = {
        htmlType_: MarkdownType.TBody,
        children_: [],
        uuid_: nanoid8(),
        mdSymbols_: [],
        htmlProps_: {},
    };

    tableData.children_.push(bodyData);

    // Split by lines and remove empty lines
    const lines = text_
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    // Parse table header
    const headers = lines[0]
        .slice(1, -1) // Remove leading and trailing |
        .split("|")
        .map((cell) => cell.trim());

    headers.forEach((h) => {
        const th = {
            htmlType_: MarkdownType.TH,
            children_: [],
            uuid_: nanoid8(),
            mdSymbols_: [],
            htmlProps_: {},
        };
        headerTRData.children_.push(th);
        parseTableCell(h, th);
    });

    // Parse data rows: real rows wrap with `|` on both sides (and need two
    // distinct boundary chars). Anything else — only one side, no `|` at all,
    // a lone `|` — is treated as autofill (mid-stream input from AI).
    lines.slice(2).forEach((line) => {
        const hasLeading = line.startsWith("|");
        const hasTrailing = line.length > 1 && line.endsWith("|");
        const isAutoFill = !(hasLeading && hasTrailing);

        let inner = line;
        if (hasLeading) inner = inner.slice(1);
        if (hasTrailing) inner = inner.slice(0, -1);
        const cells = inner.split("|").map((cell) => cell.trim());

        if (cells.length > headers.length && cells.at(-1) === CursorMarker) {
            cells.pop();
            cells[cells.length - 1] = cells[cells.length - 1] + CursorMarker;
        }

        const trData: ParentRenderData = {
            htmlType_: MarkdownType.TR,
            children_: [],
            uuid_: nanoid8(),
            mdSymbols_: isAutoFill ? [line.replaceAll(CursorMarker, "")] : [],
            htmlProps_: {},
            ...(isAutoFill ? { isAutoFill_: true } : {}),
        };
        bodyData.children_.push(trData);
        cells.forEach((col) => {
            const render: ParentRenderData = {
                htmlType_: MarkdownType.TD,
                children_: [],
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {},
                ...(isAutoFill ? { isAutoFill_: true } : {}),
            };
            parseTableCell(col, render);
            trData.children_.push(render);
        });
    });

    return tableData;
}
