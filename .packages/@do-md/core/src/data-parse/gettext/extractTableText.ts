import { CursorMarker } from "../../editor/constant";
/**
 * Check if the string starts with a table format and extract the complete
 * table text.
 *
 * The old version opened with `input.trim().split("\n").map(trim)` — on the
 * WHOLE remaining document for every `|`-leading block, one of the O(n^2)
 * parse contributors. This version gates on the first two lines and then
 * collects lazily, stopping at the first non-table line; the output is
 * byte-identical (same per-line trim, same "first non-table line after the
 * separator ends the table" rule, and whitespace-only tail lines trim to ""
 * and stop the scan exactly where the old whole-input trim dropped them).
 *
 * @param {string} input - The input string
 * @returns {string} - Returns the table text if it starts with a table; otherwise returns an empty string
 */
export function extractTableText(input: string) {
    // Left edge of the old `input.trim()`: skip leading whitespace once
    // (regex `\s` and String.trim remove the same character set).
    const leadingWhitespace = input.match(/^\s*/);
    const start = leadingWhitespace ? leadingWhitespace[0].length : 0;

    // Header + separator gate on the first two lines only.
    const headerEnd = input.indexOf("\n", start);
    if (headerEnd === -1) return ""; // fewer than two lines
    const headerLine = input.slice(start, headerEnd).trim();
    if (!headerLine.startsWith("|") || !headerLine.endsWith("|")) return "";
    const separatorEnd = input.indexOf("\n", headerEnd + 1);
    const separatorLine = (
        separatorEnd === -1
            ? input.slice(headerEnd + 1)
            : input.slice(headerEnd + 1, separatorEnd)
    ).trim();
    if (!separatorLine.match(/^\|[-:\s|]+$/)) return "";

    // Collect body lines until the first non-table line. The header and
    // separator always match the old loop's push condition, so seed them.
    const tableLines = [headerLine, separatorLine];
    if (separatorEnd === -1) return tableLines.join("\n");
    let pos = separatorEnd + 1;
    for (;;) {
        const newlineIndex = input.indexOf("\n", pos);
        const line = (
            newlineIndex === -1
                ? input.slice(pos)
                : input.slice(pos, newlineIndex)
        ).trim();
        // If the current line starts with |, consider it part of the table
        if (line.startsWith("|") || line.startsWith(CursorMarker)) {
            tableLines.push(line);
        } else {
            // After header and separator, stop extraction when encountering a non-table line
            break;
        }
        if (newlineIndex === -1) break;
        pos = newlineIndex + 1;
    }

    return tableLines.join("\n");
}
