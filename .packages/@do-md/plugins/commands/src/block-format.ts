/**
 * Block-level formatting commands: paragraph style, list flavours, blockquote,
 * fenced code, links, dividers and "clear formatting".
 *
 * Every one of them is `fn(store, ...args)` — no React, no DOM, no UI
 * assumptions — and every one is a no-op when the store is null or has no
 * usable cursor, so a host can wire a button straight to it and let
 * `readBlockFormatState` decide what to grey out.
 */

import type { EditorStoreApi, RangeEdit } from "@do-md/core-react";
import {
    buildPrefix,
    fenceMap,
    lineIndexAt,
    offsetOfLine,
    parseLine,
    stripInlineMarks,
    type HeadingLevel,
    type LineGuard,
    type ListKind,
} from "./line-format";
import {
    activeGuard,
    applyPrefixEdits,
    blockInsertOffset,
    blockPadding,
    readTarget,
    restoreSelection,
    styleableLines,
} from "./target";

/** Snapshot of the block styles at the current selection, for a host's
 *  checkmarks and pressed states. Read when a menu opens (and after each
 *  action) rather than on every render: it costs a full `toMarkdown()`, which
 *  is far too much for a render path. */
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

/** Snapshot the block styles at the current selection. */
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
 * Set the paragraph style (title / heading / subheading / body). Radio
 * semantics, matching a menu's checkmark: re-picking the active style is a
 * no-op rather than a toggle. List and quote markers are preserved — they are
 * orthogonal styles.
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

/** Named entry points for the three list flavours, for hosts that bind a
 *  button per flavour rather than passing a `ListKind` around. */
export const toggleBulletList = (store: EditorStoreApi | null): void =>
    toggleList(store, "bullet");
export const toggleOrderedList = (store: EditorStoreApi | null): void =>
    toggleList(store, "ordered");
/** Checklist entry point — a toggle, not a blind insert, so the button and the
 *  keyboard shortcut behave identically on a line that is already a to-do. */
export const toggleTodoList = (store: EditorStoreApi | null): void =>
    toggleList(store, "todo");

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
    // Virtual tail: the caret shares its md coordinate with the end of the
    // structural block above, so the fence lookup below would wrongly find —
    // and unwrap — that block. The empty line below it gets a fresh empty
    // fence of its own instead.
    if (target.virtualTail) {
        const at = target.selStart;
        const { lead } = blockPadding(target.md, at);
        const text = lead + "```\n\n```";
        store.replaceRanges({ start: at, end: at, text });
        store.setSelection({ start: at + lead.length + 4 });
        return;
    }
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
 *  translated): it lands in the user's document, not in a UI. */
const LINK_URL_PLACEHOLDER = "url";

/**
 * Turn the selection into `[text](url)` with `url` selected, or — with no
 * selection — drop an empty `[](url)` and park the caret between the brackets
 * so the label is typed first.
 */
export function insertLink(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    const { md, selStart, selEnd } = target;
    const label = md.slice(selStart, selEnd);
    const guard = activeGuard(target);
    // A link is inline content, so a table CELL is fair game — the offsets are
    // exact there. What is not fair game is a selection that runs across cell
    // walls: wrapping a `|` inside `[...]` re-columns the row and the table is
    // gone. Code and rules refuse outright: a link there is literal text, not
    // a link.
    if (guard === "code" || guard === "rule") return;
    if (guard === "table" && (label.includes("|") || label.includes("\n"))) return;
    // On the virtual tail line the link must not be glued onto the structural
    // line that shares its md coordinate — materialize the separator first.
    const lead = target.virtualTail
        ? blockPadding(md, selStart).lead
        : "";
    const text = `[${label}](${LINK_URL_PLACEHOLDER})`;
    store.replaceRanges({ start: selStart, end: selEnd, text: lead + text });
    if (label) {
        const urlStart = selStart + lead.length + label.length + 3;
        store.setSelection({ start: urlStart, end: urlStart + LINK_URL_PLACEHOLDER.length });
    } else {
        store.setSelection({ start: selStart + lead.length + 1 });
    }
}

/**
 * Drop a `---` rule at the caret: in place on an empty paragraph, otherwise
 * after the caret's line as a block of its own. See `blockPadding` for why the
 * surrounding newlines are topped up.
 */
export function insertDivider(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    // Splitting a table or a fenced block down the middle would destroy it.
    if (activeGuard(target)) return;
    const at = blockInsertOffset(target);
    const { lead, trail } = blockPadding(target.md, at);
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
