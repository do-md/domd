/**
 * Block-level formatting actions for the "Aa" menu, built on the kernel's
 * public batch-edit primitives.
 *
 * The kernel's toolbar surface covers INLINE marks only (`format()` +
 * `formatState`); headings, lists, quotes, code blocks, dividers and links
 * have no command API. Rather than reach into the render tree, we address the
 * document the way the kernel invites external editors to: absolute offsets
 * into `toMarkdown()`, rewritten through `replaceRanges`. That path runs the
 * normal scoped-reparse pipeline — one undo step per action, fine-grained ops
 * for collaborators, untouched spans keep their identity — so a menu click is
 * indistinguishable from the user typing the markers by hand.
 *
 * Absolute caret/selection offsets come from `getSelectionState(md.length)`:
 * its `before` field is the markdown source preceding the selection, so
 * `before.length` IS the caret's absolute offset (verified against
 * `setSelection`'s echoed range). `startCursorInfo` alone can't be used —
 * inside a list or quote its `uuid` names a NESTED block, not a top-level one.
 *
 * Rewrites are deliberately prefix-shaped wherever possible: only the marker
 * region of a line is replaced, never the content.
 */

import type { EditorStoreApi, RangeEdit } from "@do-md/core-react";
import {
    buildPrefix,
    fenceMap,
    lineGuards,
    lineIndexAt,
    linesInRange,
    parseLine,
    prefixLength,
    stripInlineMarks,
    type HeadingLevel,
    type LineGuard,
    type LineRange,
    type ListKind,
} from "./markdown-line-format";

/** Reactive-ish snapshot of the block styles at the current selection. Read
 *  when the menu opens (and after each action) rather than on every render:
 *  it costs a full `toMarkdown()`, which is far too much for a render path. */
export interface BlockFormatState {
    /** False when no cursor has been placed — every entry should be disabled. */
    available: boolean;
    /** Heading level shared by all touched lines, or 0 for body. Mixed
     *  selections report 0 so nothing shows a misleading checkmark. */
    heading: HeadingLevel;
    /** True when EVERY touched line already carries this list flavour. */
    bullet: boolean;
    ordered: boolean;
    todo: boolean;
    /** True when every touched line is quoted. */
    quote: boolean;
    /** True when the selection sits inside a fenced code block. */
    codeBlock: boolean;
    /** Set when the selection sits on structural lines (a table row, a `---`
     *  rule, code) where a prefix rewrite would corrupt the document rather
     *  than style it. Paragraph/list/quote entries must be disabled. */
    guard: LineGuard | null;
}

export const EMPTY_BLOCK_FORMAT_STATE: BlockFormatState = {
    available: false,
    heading: 0,
    bullet: false,
    ordered: false,
    todo: false,
    quote: false,
    codeBlock: false,
    guard: null,
};

interface FormatTarget {
    md: string;
    selStart: number;
    selEnd: number;
    /** Source lines the selection touches. */
    lines: LineRange[];
    /** Why each touched line refuses styling (null = free), index-aligned
     *  with `lines`. */
    guards: Array<LineGuard | null>;
}

/**
 * Resolve the current selection into absolute offsets plus the source lines it
 * covers. Returns null when the selection can't be addressed safely, in which
 * case the menu disables itself rather than editing the wrong region.
 *
 * Two ways that happens:
 *   - No cursor at all. `getSelectionState` then degrades to a zero-offset
 *     shape, which would silently format the document's FIRST line.
 *   - `before` doesn't line up with the serialized markdown. Inside a table
 *     cell the kernel reports a `before` that is longer than the real prefix
 *     (it misses the column padding `toMarkdown` adds), so `before.length` is
 *     off by a few characters and every edit would land skewed — measured at
 *     +4 on a 2-column table, and the wrongness grows with column width.
 *     Everywhere else tested (paragraphs, lists, quotes, blockquotes, fenced
 *     code, and text after a table) it agrees exactly.
 *
 * Rather than enumerate the structures that misbehave, verify the invariant
 * the offsets rest on: `before` MUST equal the markdown preceding the
 * selection. That is exact, costs one string compare, and fails safe for any
 * future structure with the same skew.
 */
function readTarget(store: EditorStoreApi | null): FormatTarget | null {
    if (!store || !store.startCursorInfo) return null;
    const md = store.toMarkdown();
    // Ask for the whole document as context so neither side is truncated;
    // bail rather than guess if the kernel still clipped it.
    const selection = store.getSelectionState(md.length + 1);
    if (selection.before_truncated) return null;
    const selStart = selection.before.length;
    const selEnd = selStart + selection.selected_text.length;
    if (selEnd > md.length) return null;
    if (md.slice(0, selStart) !== selection.before) return null;
    if (md.slice(selStart, selEnd) !== selection.selected_text) return null;

    const lines = linesInRange(md, selStart, selEnd);
    if (!lines.length) return null;
    const guards = lineGuards(md);
    const firstIndex = lineIndexAt(md, lines[0].start);
    return {
        md,
        selStart,
        selEnd,
        lines,
        guards: lines.map((_, i) => guards[firstIndex + i] ?? null),
    };
}

/** Lines a prefix-style action should rewrite. Structural lines (table rows,
 *  rules, code) are never rewritten — see `lineGuards`. Blank lines are
 *  skipped when the selection also covers real content, since bulleting the
 *  empty line between two paragraphs would leave a stray empty list item; a
 *  selection that is ONLY blank lines still applies, so a user can start a
 *  list on an empty line. */
function styleableLines(target: FormatTarget): LineRange[] {
    const free = target.lines.filter((_, i) => target.guards[i] === null);
    const nonBlank = free.filter((l) => l.text.trim() !== "");
    return nonBlank.length ? nonBlank : free;
}

/** The guard covering the caret's own line, which is what the menu disables
 *  on — a selection that merely brushes a table shouldn't lock the menu. */
function activeGuard(target: FormatTarget): LineGuard | null {
    return target.guards[0] ?? null;
}

/**
 * Apply a per-line prefix rewrite and restore the caret/selection on top of
 * the result. Each edit covers exactly the old prefix region, so content
 * offsets shift by a known delta and the caret can be replayed precisely.
 */
function applyPrefixEdits(
    store: EditorStoreApi,
    target: FormatTarget,
    nextPrefixFor: (line: LineRange) => string | null,
): void {
    const edits: RangeEdit[] = [];
    for (const line of styleableLines(target)) {
        const parsed = parseLine(line.text);
        const oldLength = prefixLength(line.text, parsed);
        const next = nextPrefixFor(line);
        if (next === null || next === line.text.slice(0, oldLength)) continue;
        edits.push({ start: line.start, end: line.start + oldLength, text: next });
    }
    if (!edits.length) return;

    store.replaceRanges(...edits);
    restoreSelection(store, target, edits);
}

/** Map a pre-edit offset onto the rewritten document. Edits are ordered and
 *  disjoint, so earlier ones simply shift later positions; a position that sat
 *  INSIDE a replaced prefix lands at the end of its replacement (the first
 *  content character), which is where a caret in the markers belongs. */
function shiftPosition(pos: number, edits: RangeEdit[]): number {
    let accumulated = 0;
    for (const edit of edits) {
        if (pos >= edit.end) {
            accumulated += edit.text.length - (edit.end - edit.start);
            continue;
        }
        if (pos > edit.start) return edit.start + accumulated + edit.text.length;
        break;
    }
    return pos + accumulated;
}

function restoreSelection(
    store: EditorStoreApi,
    target: FormatTarget,
    edits: RangeEdit[],
): void {
    const start = shiftPosition(target.selStart, edits);
    const end = shiftPosition(target.selEnd, edits);
    store.setSelection(end > start ? { start, end } : { start });
}

/** Snapshot the block styles at the current selection for the menu's
 *  checkmarks and pressed states. */
export function readBlockFormatState(
    store: EditorStoreApi | null,
): BlockFormatState {
    const target = readTarget(store);
    if (!target) return EMPTY_BLOCK_FORMAT_STATE;

    const guard = activeGuard(target);
    const codeBlock = guard === "code";
    const lines = styleableLines(target);
    if (guard || !lines.length) {
        return { ...EMPTY_BLOCK_FORMAT_STATE, available: true, codeBlock, guard };
    }

    const parsed = lines.map((l) => parseLine(l.text));
    const every = (fn: (p: ReturnType<typeof parseLine>) => boolean) =>
        parsed.every(fn);
    const heading = parsed[0].heading;
    return {
        available: true,
        heading: every((p) => p.heading === heading) ? heading : 0,
        bullet: every((p) => p.listKind === "bullet"),
        ordered: every((p) => p.listKind === "ordered"),
        todo: every((p) => p.listKind === "todo"),
        quote: every((p) => p.quoteDepth > 0),
        codeBlock: false,
        guard: null,
    };
}

/**
 * Set the paragraph style (标题/小标题/副标题/正文). Radio semantics, matching
 * the menu's checkmark: re-picking the active style is a no-op rather than a
 * toggle. List and quote markers are preserved — they are orthogonal styles.
 */
export function setParagraphStyle(
    store: EditorStoreApi | null,
    level: HeadingLevel,
): void {
    const target = readTarget(store);
    if (!store || !target) return;
    applyPrefixEdits(store, target, (line) => {
        const parsed = parseLine(line.text);
        if (parsed.heading === level) return null;
        return buildPrefix({ ...parsed, heading: level });
    });
}

/**
 * Toggle a list flavour across the selection. Uniform selections toggle OFF;
 * mixed or unlisted selections are converted TO the requested flavour, so one
 * click always produces a predictable, uniform result.
 */
export function toggleList(
    store: EditorStoreApi | null,
    kind: ListKind,
): void {
    const target = readTarget(store);
    if (!store || !target) return;
    const lines = styleableLines(target);
    if (!lines.length) return;
    const allSame = lines.every((l) => parseLine(l.text).listKind === kind);
    applyPrefixEdits(store, target, (line) => {
        const parsed = parseLine(line.text);
        return buildPrefix({
            ...parsed,
            listKind: allSame ? null : kind,
            checked: allSame ? false : parsed.listKind === "todo" && parsed.checked,
        });
    });
}

/** Toggle one level of blockquote across the selection. */
export function toggleQuote(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    const lines = styleableLines(target);
    if (!lines.length) return;
    const allQuoted = lines.every((l) => parseLine(l.text).quoteDepth > 0);
    applyPrefixEdits(store, target, (line) => {
        const parsed = parseLine(line.text);
        const quoteDepth = allQuoted
            ? Math.max(0, parsed.quoteDepth - 1)
            : parsed.quoteDepth + 1;
        return buildPrefix({ ...parsed, quoteDepth });
    });
}

/**
 * Wrap the selection in a ``` fence, or unwrap the fenced block the caret sits
 * in. The kernel parses a fence that butts straight up against neighbouring
 * paragraphs, so no blank-line padding is needed here.
 */
export function toggleCodeBlock(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    // A table row or a rule is structure; fencing it would swallow the block.
    if (activeGuard(target) === "table" || activeGuard(target) === "rule") return;
    const { md } = target;
    const allLines = md.split("\n");
    const fences = fenceMap(md);
    const caretLine = lineIndexAt(md, target.selStart);

    if (fences[caretLine]) {
        // Unwrap: drop the fence line above and the one below, newline included
        // so the surrounding blocks close back up.
        let open = caretLine;
        while (open > 0 && !/^[ \t]*(```|~~~)/.test(allLines[open])) open--;
        let close = caretLine;
        while (
            close < allLines.length - 1 &&
            !(close > open && /^[ \t]*(```|~~~)/.test(allLines[close]))
        ) {
            close++;
        }
        if (!/^[ \t]*(```|~~~)/.test(allLines[open])) return;
        const openStart = offsetOfLine(md, open);
        const openEnd = openStart + allLines[open].length;
        const closeStart = offsetOfLine(md, close);
        const closeEnd = closeStart + allLines[close].length;
        const hasClosing = close > open && /^[ \t]*(```|~~~)/.test(allLines[close]);
        const edits: RangeEdit[] = [
            // Swallow the newline that followed the opening fence.
            { start: openStart, end: Math.min(openEnd + 1, md.length), text: "" },
        ];
        if (hasClosing) {
            // Swallow the newline that preceded the closing fence.
            edits.push({ start: Math.max(closeStart - 1, 0), end: closeEnd, text: "" });
        }
        store.replaceRanges(...edits);
        restoreSelection(store, target, edits);
        return;
    }

    const lines = target.lines;
    const first = lines[0];
    const last = lines[lines.length - 1];
    const body = md.slice(first.start, last.end);
    const edit: RangeEdit = {
        start: first.start,
        end: last.end,
        text: "```\n" + body + "\n```",
    };
    store.replaceRanges(edit);
    // Caret follows the content, which moved down past the opening fence.
    const shift = 4;
    store.setSelection(
        target.selEnd > target.selStart
            ? { start: target.selStart + shift, end: target.selEnd + shift }
            : { start: target.selStart + shift },
    );
}

/** Placeholder written for the href half of a new link, then left selected so
 *  the next keystroke replaces it. Kept as literal markdown (never
 *  translated): it lands in the user's document, not in the UI. */
const LINK_URL_PLACEHOLDER = "url";

/**
 * Turn the selection into `[text](url)` with `url` selected, or — with no
 * selection — drop an empty `[](url)` and park the caret between the brackets
 * so the label is typed first.
 */
export function insertLink(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    // A link is inline content, so a table cell would in principle be fair
    // game — but only the HEADER row survives the offset skew described in
    // readTarget (it precedes the delimiter row the kernel re-pads), and
    // "links work in the header but not the body" is worse than "not in
    // tables". Uniformly off in structure; revisit if the kernel's
    // getSelectionState learns about column padding.
    if (activeGuard(target)) return;
    const { md, selStart, selEnd } = target;
    const label = md.slice(selStart, selEnd);
    const text = `[${label}](${LINK_URL_PLACEHOLDER})`;
    store.replaceRanges({ start: selStart, end: selEnd, text });
    if (label) {
        const urlStart = selStart + label.length + 3;
        store.setSelection({ start: urlStart, end: urlStart + LINK_URL_PLACEHOLDER.length });
    } else {
        store.setSelection({ start: selStart + 1 });
    }
}

/**
 * Drop a `---` rule after the caret's line. A thematic break only parses as
 * one when blank lines fence it off (`alpha\n---\nbeta` is just a paragraph),
 * so the surrounding newlines are topped up to two — and never past two, so
 * repeated use doesn't pile up empty paragraphs.
 */
export function insertDivider(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    // Splitting a table or a fenced block down the middle would destroy it.
    if (activeGuard(target)) return;
    const { md } = target;
    const line = target.lines[target.lines.length - 1];
    const at = line.end;

    const before = md.slice(0, at);
    const existingBefore = /\n*$/.exec(before)![0].length;
    const lead = at === 0 ? "" : "\n".repeat(Math.max(0, 2 - existingBefore));

    const after = md.slice(at);
    const existingAfter = /^\n*/.exec(after)![0].length;
    // Always leave two newlines behind the rule: `HrDiv` is not editable, so
    // the caret needs a paragraph of its own to land in.
    const trail = "\n".repeat(Math.max(0, 2 - existingAfter));

    const text = lead + "---" + trail;
    store.replaceRanges({ start: at, end: at, text });
    store.setSelection({ start: at + text.length });
}

/**
 * Strip formatting from the selection: block markers (heading, list, quote) go
 * back to plain body lines and inline mark delimiters are unwrapped. Links
 * survive — they carry a destination, which is content rather than style.
 */
export function clearFormatting(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    const lines = styleableLines(target);
    if (!lines.length) return;

    const edits: RangeEdit[] = [];
    for (const line of lines) {
        const parsed = parseLine(line.text);
        const plain = parsed.indent + stripInlineMarks(parsed.content);
        if (plain === line.text) continue;
        edits.push({ start: line.start, end: line.end, text: plain });
    }
    if (!edits.length) return;
    store.replaceRanges(...edits);
    // Whole-line rewrites make per-character mapping meaningless; collapse to
    // the head of the first cleaned line, which is always a valid caret slot.
    store.setSelection({ start: edits[0].start });
}

/** Absolute offset of line `index` (0-based) in `md`. */
function offsetOfLine(md: string, index: number): number {
    let offset = 0;
    for (let i = 0; i < index; i++) {
        const nl = md.indexOf("\n", offset);
        if (nl === -1) return md.length;
        offset = nl + 1;
    }
    return offset;
}
