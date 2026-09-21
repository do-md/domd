import { CursorMarker } from "../../editor/constant";
import { collectAreaLines } from "./collectAreaLines";

const TRAILING_AUTOFILL_RE = new RegExp(`^ *(?:[-+*] ?)?${CursorMarker}$`);

export const getULAreaText = (text: string) => {
    let isInsideList = false;
    let listIndentationLevel = 0;

    // Line-by-line decision, unchanged from the split("\n") version; only
    // the iteration is lazy now (see collectAreaLines).
    const listLines = collectAreaLines(text, (line) => {
        // Check if the current line is an unordered list item
        const listItemMatch = line.match(/^(\s*)([-+*])\s+/);

        if (listItemMatch) {
            const currentIndentation = listItemMatch[1].length;
            if (!isInsideList) {
                isInsideList = true;
                listIndentationLevel = currentIndentation;
            } else if (currentIndentation < listIndentationLevel) {
                return "stop"; // End the list
            }
            return "push";
        }

        if (line === CursorMarker) {
            return "push";
        }

        // Streaming autofill state: whitespace + optional partial bullet + cursor
        if (isInsideList && TRAILING_AUTOFILL_RE.test(line)) {
            return "push";
        }

        if (isInsideList) {
            if (line.trim() === "") {
                // Empty line, temporarily add to the list
                return "push";
            }
            // Non-empty line, check if it's part of the list
            const match = line.match(/^(\s*)/);
            const textIndentation = match ? match[0].length : 0;
            if (textIndentation > 0 || line.match(/^[-+*]\s+/)) {
                // If the line has indentation or starts with a list marker, treat it as part of the list
                return "push";
            }
            // Otherwise, end the list
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
