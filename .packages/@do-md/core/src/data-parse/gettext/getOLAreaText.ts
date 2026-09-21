import { CursorMarker } from "../../editor/constant";
import { collectAreaLines } from "./collectAreaLines";

const TRAILING_AUTOFILL_RE = new RegExp(`^ *(?:\\d+\\.? ?)?${CursorMarker}$`);

export const getOLAreaText = (text: string) => {
    let currentIndentation = 0;
    let indentPrefix = "";
    let listItemFound = false;

    // Line-by-line decision, unchanged from the split("\n") version; only
    // the iteration is lazy now (see collectAreaLines).
    const listLines = collectAreaLines(text, (line) => {
        // Check if the line starts with an ordered list marker
        const listMatch = line.match(/^(\s*)(\d+)\.\s+/);
        if (listMatch) {
            // Start of a new list item
            if (!listItemFound) {
                // First list item determines the indentation
                currentIndentation = listMatch[1].length;
                indentPrefix = " ".repeat(currentIndentation + 1);
                listItemFound = true;
            }
            return "push";
        }
        if (listItemFound) {
            // Streaming autofill state: whitespace + optional partial OL bullet + cursor
            if (TRAILING_AUTOFILL_RE.test(line)) {
                return "push";
            }
            // Check if subsequent lines are part of the list item (indented)
            const isIndented = line.startsWith(indentPrefix);
            if (line.trim() === "") {
                // Allow blank lines after finding a list item
                return "push";
            } else if (isIndented) {
                // Line is part of the current list item
                return "push";
            }
            // Line is not part of the list, stop processing
            return "stop";
        }
        return "skip";
    });

    // Remove empty lines at the end of the list
    while (
        listLines.length > 0 &&
        listLines[listLines.length - 1].trim() === ""
    ) {
        listLines.pop();
    }

    return listLines.length > 0 ? listLines.join("\n") : null;
};
