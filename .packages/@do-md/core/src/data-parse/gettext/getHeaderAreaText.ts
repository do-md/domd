import { CursorMarker } from "../../editor/constant";

// Equivalent to the six literal prefixes "# " … "###### " (backtracking
// makes "####### x" fail all widths, same as the startsWith chain did).
const HEADER_PREFIX_RE = /^#{1,6} /;

export const getHeaderAreaText = (text: string) => {
    // First line only. The old version stripped CursorMarker from the WHOLE
    // remaining document (indexOf + replaceAll — a full-document copy per
    // heading, the single largest O(n^2) parse contributor). The heading
    // prefix can only live on the first line ("\n" can never be part of
    // it), and with at most one cursor marker in a document the old
    // "strip everywhere, then re-insert at the same index" dance is an
    // identity on the returned line — so testing the marker-stripped first
    // line and returning the original first line is exactly equivalent.
    const newLineIndex = text.indexOf("\n");
    const firstLine = newLineIndex === -1 ? text : text.slice(0, newLineIndex);
    const probe = firstLine.includes(CursorMarker)
        ? firstLine.replaceAll(CursorMarker, "")
        : firstLine;
    return HEADER_PREFIX_RE.test(probe) ? firstLine : null;
};
