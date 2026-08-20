import { CursorMarker } from "../../editor/constant";

const TRAILING_AUTOFILL_RE = new RegExp(`^>? ?${CursorMarker}$`);

export const getBlockquoteAreaText = (text: string) => {
    const lines = text.split("\n");
    const quoteLines: string[] = [];
    let isInsideQuote = false;

    for (const line of lines) {
        // Check if the current line is a blockquote
        const quoteMatch = line.match(/^(\s*)>\s*/);

        if (quoteMatch) {
            if (!isInsideQuote) {
                isInsideQuote = true;
            }
            quoteLines.push(line);
            continue;
        }

        // Streaming autofill state: whitespace + optional partial `>` + cursor.
        // Keep this line inside the blockquote scope so the round-trip can render
        // the unresolved tail back instead of leaking the cursor out as a sibling.
        if (isInsideQuote && TRAILING_AUTOFILL_RE.test(line)) {
            quoteLines.push(line);
            continue;
        }

        if (isInsideQuote) {
            break;
        }
    }

    return quoteLines.length > 0 ? quoteLines.join("\n") : null;
};
