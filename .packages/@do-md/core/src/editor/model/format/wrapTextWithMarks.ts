import { InlineFormatMark } from "../../type";
import { MARK_CLOSE, MARK_OPEN, MARK_ORDER } from "./marks";

/** Wrap `text` in the delimiters of `marks`, nested in canonical MARK_ORDER
 *  (outermost → innermost), closes reversed. `closeLen_` lets the caller park
 *  the caret just before the closes so typing flows on inside the construct.
 *  The single wrapping implementation behind pending format marks. */
export const wrapTextWithMarks = (
    text: string,
    marks: InlineFormatMark[],
): { text_: string; closeLen_: number } => {
    let open = "";
    let close = "";
    for (const mark of MARK_ORDER) {
        if (!marks.includes(mark)) continue;
        open += MARK_OPEN[mark];
        close = MARK_CLOSE[mark] + close;
    }
    return { text_: open + text + close, closeLen_: close.length };
};
