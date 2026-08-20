/**
 * Batch replace planning (replaceRanges / replaceText).
 * ---------------------------------------------------------------------------
 * Public entry points live on EditorStore; this module is the pure planning
 * layer, unit-testable without a store.
 *
 * Coordinate space: absolute character offsets into the CURRENT document's
 * serialized markdown, i.e. offsets into `store.toMarkdown()` output (LF line
 * endings — callers diffing against external files must normalize CRLF first).
 *
 * Why offsets are resolved through a top-level source map + text splice
 * instead of cursor/span anchors: diff-produced offsets can land inside
 * serialization scaffolding — list markers ("- "), table pipes/padding,
 * blockquote prefixes, code fences — which occupies markdown offsets but has
 * NO representation in the cursor coordinate space (block uuid + raw text_
 * offset). A text-level splice over the affected top-level children handles
 * every offset uniformly, and the subsequent scoped reparse goes through the
 * exact same machinery the selection pipeline uses (parse fragment →
 * mergeParsedBlock keeps the first block's identity → splice), so span
 * preservation, minimal op emission and undo behave identically to a user
 * edit.
 *
 * "Anchor everything before executing" (the requirement that earlier edits
 * must not invalidate later ones) is achieved structurally instead:
 *   1. edits sharing a top-level child are merged into one GROUP and spliced
 *      into that group's original slice text in a single pass (plain string
 *      surgery against the pristine snapshot — nothing to invalidate);
 *   2. groups are disjoint in top-level children and executed in DESCENDING
 *      child order, so a group's splice never moves the children (or the
 *      serialized text) of any group before it. Serialization is per-child
 *      concat, hence the prefix invariant holds exactly.
 */
import { MarkdownType } from "../../type/enum";
import { ParentRenderData, RenderData, RootRenderData } from "../../type";
import { toMarkdown } from "../serialize/toMarkdown";
import { CursorMarker } from "../../constant";

// ---------------------------------------------------------------------------
// Public API shapes (stable keys — no `_` suffix, mangle-proof)
// ---------------------------------------------------------------------------

export interface RangeEdit {
    /** Absolute offset into the current serialized markdown, inclusive. */
    start: number;
    /** Exclusive end. start === end → pure insertion. */
    end: number;
    /** Replacement text. "" → pure deletion. */
    text: string;
}

export interface TextEdit {
    /** Exact-match needle against the current serialized markdown. */
    search: string;
    replace: string;
    /**
     * Disambiguates duplicate matches (0-based, counting non-overlapping
     * matches left to right). Absent + multiple matches → that edit fails
     * with reason "ambiguous".
     */
    occurrence?: number;
}

export type ReplaceFailureReason =
    | "invalid"
    | "out_of_bounds"
    | "overlap"
    | "not_found"
    | "ambiguous"
    | "occurrence_out_of_range";

export interface ReplaceEditResult {
    /** Position of this edit in the original arguments. */
    index: number;
    applied: boolean;
    reason?: ReplaceFailureReason;
    /** Resolved absolute range (echoed for ranges, computed for searches). */
    start?: number;
    end?: number;
}

export interface ReplaceResult {
    applied: number;
    failed: number;
    results: ReplaceEditResult[];
}

// ---------------------------------------------------------------------------
// Internal planning shapes
// ---------------------------------------------------------------------------

interface SourceMapEntry {
    /** Index in root.children_. */
    index_: number;
    /** Serialized text of this child. */
    text_: string;
    /** Absolute start offset in the document serialization. */
    start_: number;
    /** Absolute end offset (exclusive). */
    end_: number;
    /** LineBr / LineBrBr block separators. */
    isSeparator_: boolean;
}

export interface TopLevelSourceMap {
    entries_: SourceMapEntry[];
    docText_: string;
}

/** One scoped-reparse unit: children [startIndex_, startIndex_+deleteCount_) → newText_. */
export interface SliceGroup {
    startIndex_: number;
    deleteCount_: number;
    newText_: string;
}

export interface ReplacePlan {
    /** Descending by startIndex_ — safe to execute front to back. */
    groups_: SliceGroup[];
    result_: ReplaceResult;
}

// ---------------------------------------------------------------------------
// Source map
// ---------------------------------------------------------------------------

const isSeparatorType = (t: MarkdownType) =>
    t === MarkdownType.LineBr || t === MarkdownType.LineBrBr;

/**
 * Serialize each top-level child and record the absolute range it occupies.
 * The document serialization is exactly the concat of these (toMarkdown joins
 * top-level children with ""; separators are real LineBr/LineBrBr children
 * carrying their own newlines; autofill nodes serialize to "" and thus get a
 * zero-length entry).
 */
export const buildTopLevelSourceMap = (
    root: RootRenderData | ParentRenderData,
): TopLevelSourceMap => {
    const entries: SourceMapEntry[] = [];
    let acc = 0;
    const children = root.children_ || [];
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i] as ParentRenderData | RenderData;
        const text = toMarkdown(child) || "";
        entries.push({
            index_: i,
            text_: text,
            start_: acc,
            end_: acc + text.length,
            isSeparator_: isSeparatorType(child.htmlType_),
        });
        acc += text.length;
    }
    return { entries_: entries, docText_: entries.map((e) => e.text_).join("") };
};

// ---------------------------------------------------------------------------
// TextEdit → RangeEdit resolution
// ---------------------------------------------------------------------------

export interface IndexedRangeEdit extends RangeEdit {
    /** Original argument index (results are reported against it). */
    argIndex_: number;
}

/**
 * Absolute start offsets of every non-overlapping occurrence of `needle`,
 * left to right. The single definition of "a match" for the whole public
 * addressing surface — replaceText and setSelection share it so their
 * `occurrence` indices and their ambiguous/not_found verdicts can never drift.
 */
export const findOccurrences = (docText: string, needle: string): number[] => {
    const matches: number[] = [];
    let from = 0;
    for (;;) {
        const at = docText.indexOf(needle, from);
        if (at === -1) break;
        matches.push(at);
        from = at + needle.length;
    }
    return matches;
};

/**
 * Resolve search/replace edits into absolute ranges against `docText`.
 * Matches are counted non-overlapping, left to right. Failures (not found /
 * ambiguous / bad occurrence) are reported per edit; survivors continue into
 * the shared range pipeline.
 */
export const resolveTextEdits = (
    edits: TextEdit[],
    docText: string,
): { ranges_: IndexedRangeEdit[]; failures_: ReplaceEditResult[] } => {
    const ranges: IndexedRangeEdit[] = [];
    const failures: ReplaceEditResult[] = [];
    edits.forEach((edit, argIndex) => {
        const fail = (reason: ReplaceFailureReason) =>
            failures.push({ index: argIndex, applied: false, reason });
        if (
            !edit ||
            typeof edit.search !== "string" ||
            edit.search.length === 0 ||
            typeof edit.replace !== "string" ||
            (edit.occurrence !== undefined &&
                (!Number.isInteger(edit.occurrence) || edit.occurrence < 0))
        ) {
            fail("invalid");
            return;
        }
        const matches = findOccurrences(docText, edit.search);
        if (matches.length === 0) {
            fail("not_found");
            return;
        }
        let at: number;
        if (edit.occurrence !== undefined) {
            if (edit.occurrence >= matches.length) {
                fail("occurrence_out_of_range");
                return;
            }
            at = matches[edit.occurrence];
        } else if (matches.length > 1) {
            fail("ambiguous");
            return;
        } else {
            at = matches[0];
        }
        ranges.push({
            start: at,
            end: at + edit.search.length,
            text: edit.replace,
            argIndex_: argIndex,
        });
    });
    return { ranges_: ranges, failures_: failures };
};

// ---------------------------------------------------------------------------
// Range planning
// ---------------------------------------------------------------------------

/** Entry containing pos with [start, end) semantics. Zero-length entries
 *  (autofill / EmptyP, s === e) can never contain a position — both
 *  predicates skip them naturally. */
const entryAtHalfOpen = (
    entries: SourceMapEntry[],
    pos: number,
): SourceMapEntry | null => {
    for (const e of entries) {
        if (e.start_ <= pos && pos < e.end_) return e;
    }
    return null;
};

/** Entry containing pos with (start, end] semantics. */
const entryAtHalfClosed = (
    entries: SourceMapEntry[],
    pos: number,
): SourceMapEntry | null => {
    for (const e of entries) {
        if (e.start_ < pos && pos <= e.end_) return e;
    }
    return null;
};

/**
 * Attachment for a pure insertion at `pos`. Inside a child → that child. On a
 * boundary, prefer a CONTENT (non-separator) neighbor — appending to the
 * preceding paragraph first, else prepending to the following block — so the
 * reparse sees the text the insertion actually interacts with. Separator only
 * when both neighbors are separators (insertion strictly between newlines).
 */
const attachForInsert = (
    entries: SourceMapEntry[],
    pos: number,
): SourceMapEntry | null => {
    const before = entryAtHalfClosed(entries, pos); // ends at or spans pos
    const after = entryAtHalfOpen(entries, pos); // starts at or spans pos
    if (before && before.start_ < pos && pos < before.end_) return before; // strictly inside
    if (before && !before.isSeparator_) return before;
    if (after && !after.isSeparator_) return after;
    return before || after;
};

/**
 * Compute the [firstChild..lastChild] slice an edit touches, then normalize:
 * a slice must start and end on content children whenever possible, because a
 * fragment reparse without its content neighbors can weld or mis-split blocks
 * at the boundary (e.g. text left in a half-deleted separator joining the
 * next paragraph). Expanding onto separators/zero-length nodes only ever adds
 * their verbatim text to the splice input, so it is always safe.
 */
const sliceForEdit = (
    map: TopLevelSourceMap,
    edit: RangeEdit,
): { from_: number; to_: number } | null => {
    const entries = map.entries_;
    if (!entries.length) return null;
    let first: SourceMapEntry | null;
    let last: SourceMapEntry | null;
    if (edit.start === edit.end) {
        first = attachForInsert(entries, edit.start);
        last = first;
    } else {
        first = entryAtHalfOpen(entries, edit.start);
        last = entryAtHalfClosed(entries, edit.end);
    }
    if (!first || !last) return null;
    let from = first.index_;
    let to = last.index_;
    // Expand outward over separators / zero-length children so both slice
    // boundaries are content blocks (or the document edge).
    const all = map.entries_;
    while (from > 0 && (all[from].isSeparator_ || all[from].end_ === all[from].start_)) {
        from -= 1;
    }
    while (
        to < all.length - 1 &&
        (all[to].isSeparator_ || all[to].end_ === all[to].start_)
    ) {
        to += 1;
    }
    return { from_: from, to_: to };
};

/**
 * Plan a batch of range edits against a source-map snapshot.
 *
 * Failure policy: best effort. Structurally invalid edits (malformed,
 * out-of-bounds, overlapping) fail individually with a reason; every other
 * edit still applies. Overlap marks ALL involved edits as failed (no way to
 * pick a winner). An empty plan (all failed / no edits) produces no groups —
 * callers skip the state change entirely.
 */
export const planRangeEdits = (
    edits: IndexedRangeEdit[],
    map: TopLevelSourceMap,
    priorFailures: ReplaceEditResult[] = [],
): ReplacePlan => {
    const docLen = map.docText_.length;
    const results: ReplaceEditResult[] = [...priorFailures];
    const valid: IndexedRangeEdit[] = [];

    for (const edit of edits) {
        const fail = (reason: ReplaceFailureReason) =>
            results.push({
                index: edit.argIndex_,
                applied: false,
                reason,
                start: typeof edit.start === "number" ? edit.start : undefined,
                end: typeof edit.end === "number" ? edit.end : undefined,
            });
        if (
            !edit ||
            !Number.isInteger(edit.start) ||
            !Number.isInteger(edit.end) ||
            typeof edit.text !== "string" ||
            edit.start > edit.end
        ) {
            fail("invalid");
            continue;
        }
        if (edit.start < 0 || edit.end > docLen) {
            fail("out_of_bounds");
            continue;
        }
        valid.push(edit);
    }

    // Overlap detection: sort by (start, argIndex); a range overlaps the next
    // when it ends past the next one's start. Pure insertions at the same
    // offset never overlap (zero width) and apply in argument order.
    const sorted = [...valid].sort(
        (a, b) => a.start - b.start || a.argIndex_ - b.argIndex_,
    );
    const overlapping = new Set<IndexedRangeEdit>();
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i - 1].end > sorted[i].start) {
            overlapping.add(sorted[i - 1]);
            overlapping.add(sorted[i]);
        }
    }
    const survivors = sorted.filter((e) => !overlapping.has(e));
    for (const e of overlapping) {
        results.push({
            index: e.argIndex_,
            applied: false,
            reason: "overlap",
            start: e.start,
            end: e.end,
        });
    }

    // Resolve each edit's child slice; merge edits whose slices share a child
    // into one group (single splice + single scoped reparse).
    interface WorkingGroup {
        from_: number;
        to_: number;
        edits_: IndexedRangeEdit[];
    }
    const groups: WorkingGroup[] = [];
    const emptyDoc = map.docText_.length === 0;
    for (const edit of survivors) {
        let from: number;
        let to: number;
        if (emptyDoc) {
            // Nothing serializes yet (empty / placeholder-only document):
            // every valid edit is an insertion at 0 — replace all children.
            from = 0;
            to = Math.max(0, map.entries_.length - 1);
        } else {
            const slice = sliceForEdit(map, edit);
            if (!slice) {
                results.push({
                    index: edit.argIndex_,
                    applied: false,
                    reason: "invalid",
                    start: edit.start,
                    end: edit.end,
                });
                continue;
            }
            from = slice.from_;
            to = slice.to_;
        }
        const prev = groups[groups.length - 1];
        if (prev && from <= prev.to_) {
            // Slices share children (edits are start-sorted, so only the
            // previous group can collide) — merge.
            prev.to_ = Math.max(prev.to_, to);
            prev.edits_.push(edit);
        } else {
            groups.push({ from_: from, to_: to, edits_: [edit] });
        }
    }

    // Splice each group's edits into its original slice text. Edits are
    // start-sorted; splicing in REVERSE keeps every earlier edit's offsets
    // valid, and yields argument order for same-position insertions.
    const sliceGroups: SliceGroup[] = [];
    for (let g = 0; g < groups.length; g += 1) {
        const group = groups[g];
        const sliceStart = map.entries_[group.from_]?.start_ ?? 0;
        const sliceEnd = map.entries_[group.to_]?.end_ ?? 0;
        let text = map.docText_.slice(sliceStart, sliceEnd);
        for (let i = group.edits_.length - 1; i >= 0; i -= 1) {
            const e = group.edits_[i];
            const localStart = e.start - sliceStart;
            const localEnd = e.end - sliceStart;
            // Strip CursorMarker from the payload (same hygiene as insertText):
            // a stray marker would be consumed as a cursor by the parser.
            const payload = e.text.split(CursorMarker).join("");
            text = text.slice(0, localStart) + payload + text.slice(localEnd);
            results.push({
                index: e.argIndex_,
                applied: true,
                start: e.start,
                end: e.end,
            });
        }
        // A fully-deleted slice would leave its two neighboring separators
        // adjacent ("\n\n" + "\n\n"), which a fresh parse renders as an empty
        // paragraph between them. Reparse WITH the neighboring separators so
        // the tree stays canonical — but never grab a child another group
        // already owns (groups are index-ascending here).
        if (text === "" && group.to_ - group.from_ + 1 > 0) {
            const leftLimit = g > 0 ? groups[g - 1].to_ + 1 : 0;
            const rightLimit =
                g < groups.length - 1
                    ? groups[g + 1].from_ - 1
                    : map.entries_.length - 1;
            if (
                group.from_ - 1 >= leftLimit &&
                map.entries_[group.from_ - 1]?.isSeparator_
            ) {
                group.from_ -= 1;
                text = map.entries_[group.from_].text_ + text;
            }
            if (
                group.to_ + 1 <= rightLimit &&
                map.entries_[group.to_ + 1]?.isSeparator_
            ) {
                group.to_ += 1;
                text = text + map.entries_[group.to_].text_;
            }
        }
        sliceGroups.push({
            startIndex_: group.from_,
            deleteCount_: group.to_ - group.from_ + 1,
            newText_: text,
        });
    }

    // Execute descending so splices never move earlier groups' children.
    sliceGroups.sort((a, b) => b.startIndex_ - a.startIndex_);
    results.sort((a, b) => a.index - b.index);

    const applied = results.filter((r) => r.applied).length;
    return {
        groups_: sliceGroups,
        result_: {
            applied,
            failed: results.length - applied,
            results,
        },
    };
};
