export const getCheckboxesText = (text: string) => {
  const lines = text.split('\n');
  const checkboxLines: string[] = [];
  let isInsideList = false;
  let listIndentationLevel = 0;

  for (const line of lines) {
    // Check if the current line is a checkbox list item
    const checkboxItemMatch = line.match(/^(\s*)- \[( |x|X)\]\s+/);

    if (checkboxItemMatch) {
      const currentIndentation = checkboxItemMatch[1].length;
      if (!isInsideList) {
        isInsideList = true;
        listIndentationLevel = currentIndentation;
      } else if (currentIndentation < listIndentationLevel) {
        break; // End the list
      }
      checkboxLines.push(line); // Add checkbox line
      continue;
    }

    if (isInsideList) {
      if (line.trim() === '') {
        // Empty line, temporarily add to the list
        checkboxLines.push(line);
      } else {
        // Non-empty line, check if it's part of the list
        const match = line.match(/^(\s*)/);
        const textIndentation = match ? match[0].length : 0;
        if (textIndentation > 0 || line.match(/^[-+*]\s+/)) {
          // If the line has the same or greater indentation, consider it part of the list
          checkboxLines.push(line);
        } else {
          // Otherwise, end the list
          break;
        }
      }
    }
  }

  // Remove empty lines at the end of the list
  while (
    checkboxLines.length > 0 &&
    checkboxLines[checkboxLines.length - 1].trim() === ''
  ) {
    checkboxLines.pop();
  }

  return checkboxLines.length > 0 ? checkboxLines.join('\n') : null;
};
