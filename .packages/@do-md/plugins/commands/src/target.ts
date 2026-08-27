/**
 * Turning "where the caret is" into "which markdown to rewrite".
 *
 * The kernel's own toolbar surface covers INLINE marks only (`format()` +
 * `formatState`); headings, lists, quotes, code blocks, dividers, tables and
 * links have no command API by design — they live out here, in a command
 * layer, exactly the way prosemirror-schema-list sits beside prosemirror-core.
 *
 * Rather than reach into the render tree, these commands address the document
 * the way the kernel invites external editors to: absolute offsets into
 * `toMarkdown()`, rewritten through `replaceRanges`. That path runs the normal
 * scoped-reparse pipeline — one undo step per action, fine-grained ops for
 * collaborators, untouched spans keep their identity — so a command is
 * indistinguishable from the user typing the markers by hand.
 *
 * Offsets come from `getSelectionOffsets()`, the read-only dual of
 * `setSelection`'s range form. It is exact everywhere the document is, tables
 * included, and reports null when no cursor has been placed or the cursor has
 * gone stale — which is precisely when a command must do nothing rather than
 * guess.
 *
 * Rewrites are deliberately prefix-shaped wherever possible: only the marker
 * region of a line is replaced, never the content.
 */

import {
    serializeRenderData,
    type EditorStoreApi,
    type RangeEdit,
    type SerializedRenderData,
} from "@do-md/core-react";
import {
    lineGuards,
    lineIndexAt,
    linesInRange,
    parseLine,
    prefixLength,
    type LineGuard,
    type LineRange,
} from "./line-format";

export interface FormatTarget {
    md: string;
    selStart: number;
    selEnd: number;
    /** Source lines the selection touches. */
    lines: LineRange[];
    /** Why each touched line refuses styling (null = free), index-aligned
     *  with `lines`. */
    guards: Array<LineGuard | null>;
    /** True when the caret sits on a ZERO-WIDTH empty paragraph — the empty
     *  block the kernel keeps below a structural block (code fence, table,
     *  rule), most visibly the one appended at document end. It serializes
     *  to nothing, so its markdown coordinate is glued to the end of the
     *  structural line before it. `lines` then holds a single zero-width
     *  line; writes must materialize any missing blank-line separator first
     *  (applyPrefixEdits / toggleCodeBlock / insertLink, via blockPadding —
     *  which is adaptive, so an empty paragraph that already owns its blank
     *  line gets no extra padding). */
    virtualTail?: boolean;
}

/**
 * True when the collapsed caret rests on an EMPTY paragraph block. Such a
 * block serializes to ZERO characters, so its markdown coordinate merges
 * with the end of the previous line — by offsets alone it is
 * indistinguishable from a caret at the end of that line's text, and when
 * that line is structural (a fence, a table row) the guard wrongly locks
 * every block command. The distinction only exists in the model, so it is
 * read from the serialized render tree (the stable public structure
 * surface: type/uuid keys).
 */
function cursorOnEmptyParagraph(store: EditorStoreApi): boolean {
    const cursor = store.startCursorInfo;
    if (!cursor) return false;
    const stack: SerializedRenderData[] = [
        serializeRenderData(store.renderData_),
    ];
    while (stack.length) {
        const node = stack.pop()!;
        if (node.uuid === cursor.uuid) return node.type === "EmptyP";
        if (node.children) stack.push(...node.children);
    }
    return false;
}

/**
 * Resolve the current selection into absolute offsets plus the source lines it
 * covers. Returns null when there is nothing safe to act on — no cursor, a
 * stale cursor, or offsets that fall outside the document — in which case the
 * caller must no-op and the host UI should present the command as disabled.
 */
export function readTarget(store: EditorStoreApi | null): FormatTarget | null {
    if (!store) return null;
    const offsets = store.getSelectionOffsets();
    if (!offsets) return null;
    const md = store.toMarkdown();
    const { start: selStart, end: selEnd } = offsets;
    if (selStart < 0 || selEnd < selStart || selEnd > md.length) return null;

    const lines = linesInRange(md, selStart, selEnd);
    if (!lines.length) return null;
    const guards = lineGuards(md);
    const firstIndex = lineIndexAt(md, lines[0].start);

    // Zero-width empty-paragraph disambiguation. An empty paragraph that
    // directly follows a structural block (the kernel keeps one below a
    // document-final code fence / table / rule, and it can survive
    // mid-document once content is added after it) serializes to NOTHING —
    // a caret resting on it reports the very same offset as the end of the
    // structural line before it. The naive line lookup then files the caret
    // under that guarded line and every block command wrongly goes dead
    // (user-visible: click the empty line under a code block and the whole
    // Aa menu greys out, the insert buttons no-op). Offsets cannot tell the
    // two readings apart, so the MODEL is asked instead: a collapsed caret
    // whose block is an empty paragraph acts on a zero-width unguarded line
    // of its own. Writes materialize the separating blank line through the
    // adaptive `blockPadding` (applyPrefixEdits, toggleCodeBlock,
    // insertLink; the block-insert commands already pad through the same
    // helper), which degrades to no padding for an empty paragraph that
    // already owns its blank line.
    if (selStart === selEnd && cursorOnEmptyParagraph(store)) {
        return {
            md,
            selStart,
            selEnd,
            lines: [{ start: selStart, end: selStart, text: "" }],
            guards: [null],
            virtualTail: true,
        };
    }

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
export function styleableLines(target: FormatTarget): LineRange[] {
    const free = target.lines.filter((_, i) => target.guards[i] === null);
    const nonBlank = free.filter((l) => l.text.trim() !== "");
    return nonBlank.length ? nonBlank : free;
}

/** The guard covering the caret's own line, which is what a command refuses
 *  on — a selection that merely brushes a table shouldn't lock everything. */
export function activeGuard(target: FormatTarget): LineGuard | null {
    return target.guards[0] ?? null;
}

/**
 * Apply a per-line prefix rewrite and restore the caret/selection on top of
 * the result. Each edit covers exactly the old prefix region, so content
 * offsets shift by a known delta and the caret can be replayed precisely.
 */
export function applyPrefixEdits(
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
        // The virtual tail line has no characters of its own — writing its
        // prefix at md.length would glue it onto the structural line above
        // (a fence line would become "```## "), so the separating blank
        // line is materialized first.
        const lead = target.virtualTail
            ? blockPadding(target.md, line.start).lead
            : "";
        edits.push({
            start: line.start,
            end: line.start + oldLength,
            text: lead + next,
        });
    }
    if (!edits.length) return;

    store.replaceRanges(...edits);
    restoreSelection(store, target, edits);
}

/** Map a pre-edit offset onto the rewritten document. Edits are ordered and
 *  disjoint, so earlier ones simply shift later positions; a position that sat
 *  INSIDE a replaced prefix lands at the end of its replacement (the first
 *  content character), which is where a caret in the markers belongs. */
export function shiftPosition(pos: number, edits: RangeEdit[]): number {
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

export function restoreSelection(
    store: EditorStoreApi,
    target: FormatTarget,
    edits: RangeEdit[],
): void {
    const start = shiftPosition(target.selStart, edits);
    const end = shiftPosition(target.selEnd, edits);
    store.setSelection(end > start ? { start, end } : { start });
}

/**
 * Newline padding for dropping a standalone block (a rule, a table) into
 * `md` at absolute offset `at`.
 *
 * A block-level construct only parses as one when blank lines fence it off
 * (`alpha\n---\nbeta` is just a paragraph), so the surrounding newlines are
 * topped up to two — and never past two, so repeated use doesn't pile up empty
 * paragraphs. Two newlines behind is not optional either: a table or rule the
 * caret cannot enter needs a paragraph of its own to fall out into.
 */
export function blockPadding(
    md: string,
    at: number,
): { lead: string; trail: string } {
    const existingBefore = /\n*$/.exec(md.slice(0, at))![0].length;
    const existingAfter = /^\n*/.exec(md.slice(at))![0].length;
    return {
        lead: at === 0 ? "" : "\n".repeat(Math.max(0, 2 - existingBefore)),
        trail: "\n".repeat(Math.max(0, 2 - existingAfter)),
    };
}

/**
 * Where a standalone block should land relative to the caret.
 *
 * An empty line is the user's own "put it here" gesture — the kernel treats an
 * empty paragraph as a legal insertion point, so the block replaces it in
 * place. Anywhere else the caret sits inside real content, which a block may
 * not split, so the block goes AFTER the caret's line and becomes a new block
 * of its own.
 */
export function blockInsertOffset(target: FormatTarget): number {
    const line = target.lines[target.lines.length - 1];
    return line.text.trim() === "" ? line.start : line.end;
}
