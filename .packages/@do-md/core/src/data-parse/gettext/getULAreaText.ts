import { CursorMarker } from "../../editor/constant";

const TRAILING_AUTOFILL_RE = new RegExp(`^ *(?:[-+*] ?)?${CursorMarker}$`);

export const getULAreaText = (text: string) => {
    const lines = text.split("\n");
    const listLines: string[] = [];
    let isInsideList = false;
    let listIndentationLevel = 0;

    for (const line of lines) {
        // Check if the current line is an unordered list item
        const listItemMatch = line.match(/^(\s*)([-+*])\s+/);

        if (listItemMatch) {
            const currentIndentation = listItemMatch[1].length;
            if (!isInsideList) {
                isInsideList = true;
                listIndentationLevel = currentIndentation;
            } else if (currentIndentation < listIndentationLevel) {
                break; // End the list
            }
            listLines.push(line); // Remove trailing spaces
            continue;
        }

        if (line === CursorMarker) {
            listLines.push(line);
            continue;
        }

        // Streaming autofill state: whitespace + optional partial bullet + cursor
        if (isInsideList && TRAILING_AUTOFILL_RE.test(line)) {
            listLines.push(line);
            continue;
        }

        if (isInsideList) {
            if (line.trim() === "") {
                // Empty line, temporarily add to the list
                listLines.push(line);
            } else {
                // Non-empty line, check if it's part of the list
                const match = line.match(/^(\s*)/);
                const textIndentation = match ? match[0].length : 0;
                if (textIndentation > 0 || line.match(/^[-+*]\s+/)) {
                    // If the line has indentation or starts with a list marker, treat it as part of the list
                    listLines.push(line);
                } else {
                    // Otherwise, end the list
                    break;
                }
            }
        }
    }

    // Remove empty lines at the end of the list
    while (
        listLines.length > 0 &&
        listLines[listLines.length - 1].trim() === ""
    ) {
        listLines.pop();
    }

    return listLines.length > 0 ? listLines.join("\n") : null;
};
