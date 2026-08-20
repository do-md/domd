import { CursorMarker } from "../../constant";
import { MarkdownType } from "../../type/enum";
import {
    CursorInfo,
    InlineFormat,
    ParentRenderData,
    RenderData,
    RootRenderData,
} from "../../type";
// ⚠️ format ⇄ serialize module cycle (see the header comment in
// format/inlineItems.ts): both sides only call across it from inside function
// bodies, which is safe under ESM live bindings.
import { serializeInlineWithFormat } from "../format/serializeInlineWithFormat";

/**
 * The one serializer from a RenderData tree to markdown text — the outbound
 * half of the round-trip, and public API. `cursorInfos` injects CursorMarkers
 * for cursor addressing (the getSelectionOffsets / getSelectionState family
 * relies on the marker-bearing output matching the canonical one byte for byte
 * once the markers are stripped); `format` triggers a single-block inline
 * re-serialization (serializeInlineWithFormat).
 */
export const toMarkdown = (
    parsedData: ParentRenderData | RootRenderData | RenderData,
    cursorInfos: CursorInfo[] = [],
    format?: InlineFormat,
): string => {
    const renderTable = (
        table: ParentRenderData | RenderData,
        listDepth: number,
    ): string => {
        const headerChildren =
            table.children_?.[0].children_?.[0]?.children_ || [];
        const body = table.children_?.[1];

        const headerChildrenText = headerChildren.map(
            (child) => processNode(child, listDepth) || "",
        );
        const bodyEntries = (body?.children_ || []).map((tr) => {
            if (tr.isAutoFill_) {
                return {
                    autoFillRaw: tr.mdSymbols_[0] ?? "",
                    cells: null as string[] | null,
                };
            }
            const trChildren = tr.children_ || [];
            return {
                autoFillRaw: null as string | null,
                cells: trChildren.map(
                    (trChild) => processNode(trChild, listDepth) || "",
                ),
            };
        });

        // Cell text may carry injected CursorMarkers (getSelectionState /
        // getSelectionOffsets locate the cursor through marker-bearing
        // serialization). Column widths and padding must be measured on the
        // marker-stripped text, so that stripping the markers from this output
        // reproduces the canonical one byte for byte — otherwise a marker
        // widens the widest cell / eats into its own padding, and every offset
        // inside the table and after it is skewed (measured at +4 on a
        // two-column table).
        const markerFreeLength = (text: string) =>
            text.split(CursorMarker).join("").length;
        const columnsMaxLength = headerChildrenText.map((_, colIndex) => {
            const headerLength = markerFreeLength(
                headerChildrenText[colIndex] || "",
            );
            const bodyLengths = bodyEntries.map((entry) =>
                markerFreeLength(entry.cells?.[colIndex] || ""),
            );
            return Math.max(headerLength, ...bodyLengths);
        });
        // Add the markers' own length back into the padEnd target: a marker
        // takes up no visible width.
        const padCell = (text: string, colIndex: number) =>
            text.padEnd(
                columnsMaxLength[colIndex] +
                    (text.length - markerFreeLength(text)),
            );

        const headerText = `| ${headerChildrenText.map(padCell).join(" | ")} |`;
        const separatorLine = `| ${columnsMaxLength.map((length) => "-".repeat(length)).join(" | ")} |`;
        const bodyTexts = bodyEntries.map((entry) =>
            entry.cells
                ? `| ${entry.cells.map(padCell).join(" | ")} |`
                : (entry.autoFillRaw ?? ""),
        );

        // Header-only table (no body rows): no trailing newline — the naive
        // join would emit `header\nsep\n`, and that phantom newline breaks
        // the round-trip (a reparse of the reserialized text sees an extra
        // blank line the model never had).
        return bodyTexts.length
            ? `${headerText}\n${separatorLine}\n${bodyTexts.join("\n")}`
            : `${headerText}\n${separatorLine}`;
    };

    const renderBlockquote = (
        blockquote: ParentRenderData | RenderData,
        listDepth: number,
        inAutoFill: boolean,
    ): string => {
        const isAutoFillSubtree = inAutoFill || blockquote.isAutoFill_ === true;
        const children = blockquote.children_ || [];
        const parts: string[] = [];

        for (const child of children) {
            const childText =
                processNode(child, listDepth, isAutoFillSubtree) || "";
            // LineBr/LineBrBr carry the raw `\n`, `\n>\n`, or `\n` + autofill
            // prefix verbatim; autofill subtrees emit only the cursor marker.
            // Both must pass through without an extra `> ` per line.
            const passThrough =
                child.isAutoFill_ ||
                isAutoFillSubtree ||
                child.htmlType_ === MarkdownType.LineBr ||
                child.htmlType_ === MarkdownType.LineBrBr;

            if (passThrough) {
                parts.push(childText);
            } else {
                parts.push(
                    childText
                        .split("\n")
                        .map((line) => (line.length === 0 ? ">" : "> " + line))
                        .join("\n"),
                );
            }
        }

        return parts.join("");
    };

    const processNode = (
        node: ParentRenderData | RenderData,
        listDepth: number,
        inAutoFill: boolean = false,
    ) => {
        let text = "";

        const isAutoFillSubtree = inAutoFill || node.isAutoFill_ === true;

        // Process text content
        if (node.htmlType_ === MarkdownType.CheckboxesInput) {
            text = node.htmlProps_.checked ? "[x] " : "[ ] ";
        } else if (node.text_ !== undefined) {
            text = isAutoFillSubtree ? "" : node.text_;
        } else {
            // Table is rendered atomically here so toMarkdown(table) works even
            // when called directly without a parent loop wrapping it.
            if (
                node.htmlType_ === MarkdownType.Table &&
                node.children_?.length === 2
            ) {
                return renderTable(node, listDepth);
            }

            if (node.htmlType_ === MarkdownType.Blockquote) {
                return renderBlockquote(node, listDepth, isAutoFillSubtree);
            }

            const newListDepth =
                node.htmlType_ === MarkdownType.Ul ||
                node.htmlType_ === MarkdownType.Ol
                    ? listDepth + 1
                    : listDepth;

            const childrenText = [];
            let liIndex = 0;

            // Recursively process child nodes
            if (node.children_) {
                for (let i = 0; i < node.children_.length; i += 1) {
                    const cur = node.children_[i];

                    let childText =
                        processNode(cur, newListDepth, isAutoFillSubtree) || "";

                    if (
                        !cur.isAutoFill_ &&
                        !isAutoFillSubtree &&
                        (cur.htmlType_ === MarkdownType.li ||
                            cur.htmlType_ === MarkdownType.CheckBoxLi)
                    ) {
                        if (node.htmlType_ === MarkdownType.Ul) {
                            childText = childText
                                .split("\n")
                                .map((line, index) => {
                                    if (index === 0)
                                        return (
                                            node.htmlProps_["data-mark"] +
                                            " " +
                                            line
                                        );
                                    if (!line) return line;
                                    return "  " + line;
                                })
                                .join("\n");
                        } else if (node.htmlType_ === MarkdownType.Ol) {
                            const symbol = `${(node.htmlProps_.start || 1) + liIndex}. `;
                            childText = childText
                                .split("\n")
                                .map((line, index) => {
                                    if (index === 0) return symbol + line;
                                    if (!line) return line;
                                    return " ".repeat(symbol.length) + line;
                                })
                                .join("\n");
                        }
                        liIndex += 1;
                    }

                    childrenText.push(childText);
                }
            }

            text = childrenText.join("");
        }
        if (
            cursorInfos[0] &&
            cursorInfos[1] &&
            node.htmlProps_["data-render-id"] === cursorInfos[0].uuid &&
            node.htmlProps_["data-render-id"] === cursorInfos[1].uuid
        ) {
            const startOffset = Math.min(
                cursorInfos[0].offset,
                cursorInfos[1].offset,
            );
            const endOffset = Math.max(
                cursorInfos[0].offset,
                cursorInfos[1].offset,
            );
            // Single-block selection with a format request: re-serialize this
            // block's inline with the mark toggled (CursorMarkers included).
            if (format) {
                text = serializeInlineWithFormat(
                    node,
                    startOffset,
                    endOffset,
                    format,
                );
            } else {
                text =
                    text.slice(0, startOffset) +
                    CursorMarker +
                    text.slice(startOffset, endOffset) +
                    CursorMarker +
                    text.slice(endOffset);
            }
        } else if (
            cursorInfos[0] &&
            node.htmlProps_["data-render-id"] === cursorInfos[0].uuid
        ) {
            text =
                text.slice(0, cursorInfos[0].offset) +
                CursorMarker +
                text.slice(cursorInfos[0].offset);
        } else if (
            cursorInfos[1] &&
            node.htmlProps_["data-render-id"] === cursorInfos[1].uuid
        ) {
            text =
                text.slice(0, cursorInfos[1].offset) +
                CursorMarker +
                text.slice(cursorInfos[1].offset);
        }

        return text;
    };

    return processNode(parsedData, 0) || "";
};
