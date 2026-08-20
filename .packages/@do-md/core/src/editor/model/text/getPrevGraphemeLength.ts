/**
 * UTF-16 code-unit length of the grapheme cluster before the cursor (0 when
 * index <= 0).
 *
 * Backspace has to delete "one user-perceived character" rather than a fixed
 * single code unit — otherwise it cuts through a surrogate pair (emoji and the
 * like) / a ZWJ sequence (👨‍👩‍👧) / a flag (🇨🇳 = two regional indicators) /
 * a skin-tone modifier (👍🏽), leaving an orphan surrogate code unit that the
 * browser renders as the U+FFFD replacement character `�`.
 *
 * Prefers Intl.Segmenter, which matches the browser's native backspace; when it
 * is missing, the fallback handles basic surrogate pairs only.
 */
const graphemeSegmenter: Intl.Segmenter | null =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;

export function getPrevGraphemeLength(text: string, index: number): number {
    if (index <= 0) return 0;
    if (index > text.length) index = text.length;
    if (graphemeSegmenter) {
        // Segmenter only segments forward: take the length of the last
        // segment covering [0, index) — i.e. the whole grapheme cluster that
        // ends at index.
        let last = 1;
        for (const seg of graphemeSegmenter.segment(text.slice(0, index))) {
            last = seg.segment.length;
        }
        return last;
    }
    // Fallback for old environments without Segmenter: basic surrogate pairs
    // only
    const lo = text.charCodeAt(index - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff && index >= 2) {
        const hi = text.charCodeAt(index - 2);
        if (hi >= 0xd800 && hi <= 0xdbff) return 2;
    }
    return 1;
}