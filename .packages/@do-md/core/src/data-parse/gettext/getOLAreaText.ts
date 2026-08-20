import { CursorMarker } from "../../editor/constant";

const TRAILING_AUTOFILL_RE = new RegExp(`^ *(?:\\d+\\.? ?)?${CursorMarker}$`);

export const getOLAreaText = (text: string) => {
    // const lines = text.split('\n');

    // const listLines: string[] = [];
    // let isInsideList = false;
    // let listIndentationLevel = 0;
    // let previousLineWasListItem = false;

    // for (const line of lines) {
    //   if (line.trim() === '' && isInsideList) {
    //     // If it's an empty line and currently inside a list, add it to the list
    //     listLines.push(line);
    //     previousLineWasListItem = false;
    //     continue;
    //   }

    //   // Check if the current line is an ordered list item
    //   const listItemMatch = line.match(/^(\s*)(\d+\.)\s+/);
    //   if (listItemMatch) {
    //     const currentIndentation = listItemMatch[1].length;

    //     if (!isInsideList) {
    //       // First list item, mark entry into the list
    //       listIndentationLevel = currentIndentation;
    //       isInsideList = true;
    //     } else if (currentIndentation < listIndentationLevel) {
    //       // Current item indentation is less than top-level list item indentation, end list extraction
    //       break;
    //     }
    //     // Update list item indentation level
    //     listIndentationLevel = currentIndentation;
    //     listLines.push(line);
    //     previousLineWasListItem = true;
    //   } else if (isInsideList) {
    //     // If the current line is indented text
    //     const textIndentation = line.match(/^(\s*)/)[0].length;
    //     if (textIndentation >= listIndentationLevel || previousLineWasListItem) {
    //       // If indentation level is greater than or equal to top-level list item indentation, or previous line was a list item, treat it as part of the list
    //       listLines.push(line);
    //       previousLineWasListItem = false;
    //     } else {
    //       // If indentation level is less than top-level list item indentation, end list extraction
    //       break;
    //     }
    //   }
    // }

    // // Remove empty lines at the end of the list
    // while (
    //   listLines.length > 0 &&
    //   listLines[listLines.length - 1].trim() === ''
    // ) {
    //   listLines.pop();
    // }

    // return listLines.length > 0 ? listLines.join('\n') : null;

    const lines = text.split("\n");
    const listLines: string[] = [];
    let currentIndentation = 0;
    let listItemFound = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check if the line starts with an ordered list marker
        const listMatch = line.match(/^(\s*)(\d+)\.\s+/);
        if (listMatch) {
            // Start of a new list item
            if (!listItemFound) {
                // First list item determines the indentation
                currentIndentation = listMatch[1].length;
                listItemFound = true;
            }
            listLines.push(line);
        } else if (listItemFound) {
            // Streaming autofill state: whitespace + optional partial OL bullet + cursor
            if (TRAILING_AUTOFILL_RE.test(line)) {
                listLines.push(line);
                continue;
            }
            // Check if subsequent lines are part of the list item (indented)
            const isIndented = line.startsWith(
                " ".repeat(currentIndentation + 1),
            );
            if (line.trim() === "") {
                // Allow blank lines after finding a list item
                listLines.push(line);
            } else if (isIndented) {
                // Line is part of the current list item
                listLines.push(line);
            } else {
                // Line is not part of the list, stop processing
                break;
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
