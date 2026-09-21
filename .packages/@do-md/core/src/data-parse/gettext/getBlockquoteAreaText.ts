import { CursorMarker } from "../../editor/constant";
import { collectAreaLines } from "./collectAreaLines";

const TRAILING_AUTOFILL_RE = new RegExp(`^>? ?${CursorMarker}$`);

export const getBlockquoteAreaText = (text: string) => {
    let isInsideQuote = false;

    // Line-by-line decision, unchanged from the split("\n") version; only
    // the iteration is lazy now (see collectAreaLines).
    const quoteLines = collectAreaLines(text, (line) => {
        // Check if the current line is a blockquote
        const quoteMatch = line.match(/^(\s*)>\s*/);

        if (quoteMatch) {
            if (!isInsideQuote) {
                isInsideQuote = true;
            }
            return "push";
        }

        // Streaming autofill state: whitespace + optional partial `>` + cursor.
        // Keep this line inside the blockquote scope so the round-trip can render
        // the unresolved tail back instead of leaking the cursor out as a sibling.
        if (isInsideQuote && TRAILING_AUTOFILL_RE.test(line)) {
            return "push";
        }

        if (isInsideQuote) {
            return "stop";
        }
        return "skip";
    });

    return quoteLines.length > 0 ? quoteLines.join("\n") : null;
};
