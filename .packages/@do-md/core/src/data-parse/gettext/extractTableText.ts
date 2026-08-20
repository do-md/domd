import { CursorMarker } from "../../editor/constant";
/**
 * Check if the string starts with a table format and extract the complete table text
 * @param {string} input - The input string
 * @returns {string} - Returns the table text if it starts with a table; otherwise returns an empty string
 */
export function extractTableText(input: string) {
    // Trim whitespace and split by lines
    const lines = input
        .trim()
        .split("\n")
        .map((line) => line.trim());

    // Check if there are at least two lines (header + separator)
    if (lines.length < 2) return "";

    // Check if the first line starts and ends with |
    if (!lines[0].startsWith("|") || !lines[0].endsWith("|")) return "";

    // Check if the second line is a separator (contains ---)
    if (!lines[1].match(/^\|[-:\s|]+$/)) return "";

    // Extract complete table lines
    let tableLines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // If the current line starts with |, consider it part of the table
        if (line.startsWith("|") || line.startsWith(CursorMarker)) {
            tableLines.push(line);
        } else if (i > 1) {
            // After header and separator, stop extraction when encountering a non-table line
            break;
        }
    }

    return tableLines.length >= 2 ? tableLines.join("\n") : "";
}
