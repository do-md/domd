/**
 * The [start, end) extent of the line surrounding `offset` in `text`:
 * from the character after the previous "\n" to the next "\n" (or the
 * text end). The extent never includes a newline, so a selection built
 * from it can never cross a block boundary.
 *
 * Used by the multi-click (triple-click) takeover to compute what "the
 * paragraph" means inside a single render block: a paragraph or a table
 * cell has no inner "\n", so the extent is the whole block content; a
 * multi-line code area yields the clicked code line — the same
 * granularity browsers use natively (preserved newlines act as
 * paragraph boundaries for triple-click).
 *
 * `offset` is clamped into [0, text.length]. An offset sitting exactly
 * on a "\n" belongs to the line that newline terminates.
 */
export const getLineExtent = (
    text: string,
    offset: number,
): { start: number; end: number } => {
    const at = Math.max(0, Math.min(offset, text.length));
    const start = text.slice(0, at).lastIndexOf("\n") + 1;
    const nextBreak = text.indexOf("\n", at);
    return { start, end: nextBreak === -1 ? text.length : nextBreak };
};
