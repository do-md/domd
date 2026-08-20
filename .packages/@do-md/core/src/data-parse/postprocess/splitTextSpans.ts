import { MarkdownType } from "../../editor/type/enum";
import { ParentRenderData, RenderData } from "../../editor/type";
import { createTextRenderData } from "../create-render-data/createTextRenderData";

/**
 * Post-process pass: pre-split one large plain-text span into sentence-level
 * spans.
 *
 * Motivation: parseMarkdown emits a single large text leaf for a paragraph
 * that contains no inline syntax. Under the merge rules — "a span is an
 * immutable atom + the changed region is expanded out to top-level child
 * boundaries" (mergeInlineBlock) — any edit in the middle of a single-span
 * paragraph replaces the entire span, and the reparse still yields one large
 * span, so a document loaded from markdown would stay at paragraph-level
 * CRDT granularity forever. After pre-splitting, edits and merges land on
 * sentence spans naturally.
 *
 * Mount points (only on the "markdown text → RenderData" seams):
 * - EditorStore construction (initMd) and resetMD — split the whole tree at
 *   load time;
 * - the reparse output of chain `resetTextByUUID_` — split at edit time. The
 *   first time an existing single-span paragraph is edited, the changed
 *   region is taken from the already-split reparse → a single edit restores
 *   fine granularity in place, while untouched paragraphs keep the coarse
 *   granularity (zero cost).
 * applyExternalRenderData / setParsedData_ take already-parsed data and do
 * not go through this pass (span structure that arrives over sync is kept
 * exactly as it is).
 *
 * Rules:
 * - Only the **top-level plain-text leaves** of P blocks and Header wrappers
 *   are split (Plain, no mdSymbols, no children) — the same scope
 *   mergeInlineBlock merges over;
 * - Break points: a CJK sentence/clause terminator (。！？；…，、：), a
 *   newline, or a Latin sentence/clause terminator (.!?;,:) followed by a
 *   space — a clause or phrase is the natural unit of concurrent editing,
 *   and breaking on sentence ends alone is still far too coarse for long
 *   sentences (especially English written without sentence-ending
 *   punctuation);
 * - The length backstop accumulates a **per-character weight** (an
 *   information-density compensation): weight 1 for Latin, weight 6 for CJK,
 *   break once the total is ≥32 — 32 characters per chunk for pure English,
 *   ~6 characters per chunk for pure Chinese (a Han character is a whole
 *   morpheme, and a pure Han run between commas has no spaces to break on,
 *   so capping on the raw character count would leave Chinese granularity
 *   more than twice as coarse as it should be); mixed text scales in
 *   between. A break prefers a space and hard-breaks when there is none
 *   (with surrogate-pair protection).
 * Splitting is a deterministic pure function; rendering many spans is
 * visually identical to rendering one (toMarkdown concatenation and
 * block-level cursor offsets are both unaffected).
 */

/** Leaves shorter than this many characters are skipped outright (below the
 *  minimum chunk size, so a scan is guaranteed to produce a single chunk) */
const MIN_SCAN_LENGTH = 6;
/** Upper weight bound for one chunk */
const MAX_CHUNK_WEIGHT = 32;
/** Per-character weight of a dense character (CJK ideograph / kana /
 *  hangul): 32/6 ≈ one break every 6 characters in pure CJK */
const DENSE_CHAR_WEIGHT = 6;

/** High information-density characters: Han (incl. Extension A), Japanese
 *  kana, Hangul syllables */
const isDenseChar = (code: number): boolean =>
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana / Katakana
    (code >= 0xac00 && code <= 0xd7af); // Hangul Syllables

const textWeight = (text: string): number => {
    let weight = 0;
    for (const ch of text) {
        weight +=
            ch.length === 1 && isDenseChar(ch.charCodeAt(0))
                ? DENSE_CHAR_WEIGHT
                : 1;
    }
    return weight;
};

/**
 * UAX #29 word-boundary segmenter (used to align the break point when the
 * weight cap is hit — the CJK counterpart of "find a space", so a word is
 * never cut in half; when a concurrent conflict lands on a cut word the
 * interleaving looks terrible).
 * Feature detection rather than environment detection: Node ≥16 (full-icu)
 * and every modern browser support it natively; when it is missing we fall
 * back to a hard break. Note that the split needs no cross-engine
 * determinism (the split travels with the synced content, and the
 * shared-origin discipline guarantees it is created on exactly one peer) —
 * only determinism within one engine, which Segmenter satisfies.
 */
const wordSegmenter: Intl.Segmenter | null =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "word" })
        : null;

/** Find the largest b in the sorted boundary table with lo < b < hi, or -1
 *  when there is none (binary search) */
const findBoundaryIn = (
    boundaries: number[],
    lo: number,
    hi: number,
): number => {
    let left = 0;
    let right = boundaries.length - 1;
    let best = -1;
    while (left <= right) {
        const mid = (left + right) >> 1;
        if (boundaries[mid] < hi) {
            best = boundaries[mid];
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return best > lo ? best : -1;
};

const CJK_BREAKERS = new Set([
    "。",
    "！",
    "？",
    "；",
    "…",
    "，",
    "、",
    "：",
    "\n",
]);
const LATIN_BREAKERS = new Set([".", "!", "?", ";", ",", ":"]);

const HEADER_TYPES = new Set<MarkdownType>([
    MarkdownType.H1,
    MarkdownType.H2,
    MarkdownType.H3,
    MarkdownType.H4,
    MarkdownType.H5,
    MarkdownType.H6,
]);

type AnyNode = RenderData | ParentRenderData;

/** A top-level plain-text leaf: no markdown semantics, so it is safe to
 *  re-cut by character (same test as merge's isSliceableText) */
const isPlainLeaf = (node: AnyNode): boolean =>
    !node.children_ &&
    node.htmlType_ === MarkdownType.Plain &&
    node.mdSymbols_.length === 0;

const isHighSurrogate = (ch: string): boolean => {
    const code = ch.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdbff;
};

/** Cut a plain-text run into chunks at sentence boundaries + the weight cap
 *  (deterministic) */
export const chunkPlainText = (text: string): string[] => {
    const chunks: string[] = [];
    // Segment the whole text once to get a table of absolute word-boundary
    // indices, in two tiers:
    // - strong boundaries: adjacent to at least one multi-character segment
    //   (a dictionary hit, so trustworthy);
    // - all boundaries: including single-char-next-to-single-char boundaries
    //   (the gaps where ICU's Chinese dictionary misses — words such as
    //   "权重/文档/剪枝" get cut into single characters; these weak
    //   boundaries are only a last resort).
    // A break prefers a strong boundary → a weak boundary → a hard cut. Real
    // single-character words (的/了/是) always sit next to a multi-character
    // word, so their boundaries are strong ones anyway and this heuristic
    // never hurts them.
    let strongBoundaries: number[] | null = null;
    let allBoundaries: number[] | null = null;
    if (wordSegmenter) {
        strongBoundaries = [];
        allBoundaries = [];
        let prevLen = 0;
        for (const seg of wordSegmenter.segment(text)) {
            const segLen = seg.segment.length;
            if (seg.index > 0) {
                allBoundaries.push(seg.index);
                if (prevLen > 1 || segLen > 1) {
                    strongBoundaries.push(seg.index);
                }
            }
            prevLen = segLen;
        }
    }
    let cur = "";
    let weight = 0;
    /** Absolute index of cur's start within text (UTF-16 units, aligned
     *  with Segmenter) */
    let chunkStart = 0;
    for (let i = 0; i < text.length; i += 1) {
        let ch = text[i];
        // Keep surrogate pairs atomic (emoji and friends) so no break point
        // can land in the middle of a pair
        if (isHighSurrogate(ch) && i + 1 < text.length) {
            ch += text[i + 1];
            i += 1;
        }
        cur += ch;
        weight +=
            ch.length === 1 && isDenseChar(ch.charCodeAt(0))
                ? DENSE_CHAR_WEIGHT
                : 1;
        const end = i + 1; // absolute index of cur's end (exclusive)
        if (CJK_BREAKERS.has(ch)) {
            chunks.push(cur);
            cur = "";
            weight = 0;
            chunkStart = end;
            continue;
        }
        // Latin sentence end: break after the space that follows ".!?;"
        // ("Hello. |World")
        if (ch === " " && LATIN_BREAKERS.has(cur[cur.length - 2] ?? "")) {
            chunks.push(cur);
            cur = "";
            weight = 0;
            chunkStart = end;
            continue;
        }
        if (weight >= MAX_CHUNK_WEIGHT) {
            const spaceIdx = cur.lastIndexOf(" ");
            if (spaceIdx > cur.length / 2) {
                // Latin: break at the space (the space joins the preceding
                // chunk)
                chunks.push(cur.slice(0, spaceIdx + 1));
                cur = cur.slice(spaceIdx + 1);
                weight = textWeight(cur);
                chunkStart = end - cur.length;
                continue;
            }
            // No space (CJK and friends): align to the nearest UAX #29 word
            // boundary inside the second half (strong boundaries first, weak
            // ones as fallback) so a word like "权重/文档" is not cut in half
            const lo = chunkStart + cur.length / 2;
            let b = strongBoundaries
                ? findBoundaryIn(strongBoundaries, lo, end)
                : -1;
            if (b < 0 && allBoundaries) {
                b = findBoundaryIn(allBoundaries, lo, end);
            }
            if (b > 0) {
                chunks.push(cur.slice(0, b - chunkStart));
                cur = cur.slice(b - chunkStart);
                weight = textWeight(cur);
                chunkStart = b;
            } else {
                // No usable word boundary (Segmenter missing, or one
                // absurdly long word): hard break as the backstop
                chunks.push(cur);
                cur = "";
                weight = 0;
                chunkStart = end;
            }
        }
    }
    if (cur) chunks.push(cur);
    return chunks;
};

/** Split a container's top-level plain-text leaves in place */
const splitContainerLeaves = (container: ParentRenderData) => {
    for (let i = container.children_.length - 1; i >= 0; i -= 1) {
        const child = container.children_[i];
        if (!isPlainLeaf(child)) continue;
        const text = (child as RenderData).text_;
        if (text.length < MIN_SCAN_LENGTH) continue;
        const chunks = chunkPlainText(text);
        if (chunks.length <= 1) continue;
        container.children_.splice(
            i,
            1,
            ...chunks.map((t) => createTextRenderData({ text_: t })),
        );
    }
};

/**
 * Walk the tree recursively, splitting the top-level plain-text leaves of
 * every P block and Header wrapper.
 * Mutates in place (only for a freshly parsed tree that has not entered the
 * store yet).
 */
export const splitTextSpans = (node: AnyNode): void => {
    if (!node.children_) return;
    if (node.htmlType_ === MarkdownType.P) {
        splitContainerLeaves(node as ParentRenderData);
    } else if (HEADER_TYPES.has(node.htmlType_)) {
        const wrapper = node.children_[1];
        if (wrapper?.children_) {
            splitContainerLeaves(wrapper as ParentRenderData);
        }
    }
    node.children_.forEach(splitTextSpans);
};
