/**
 * Programmatic selection addressing (setSelection).
 * ---------------------------------------------------------------------------
 * Public entry point lives on EditorStore; this module is the pure addressing
 * layer, unit-testable without a store.
 *
 * Coordinate space and failure vocabulary are the batch replace API's (see
 * ../replace/plan.ts): absolute character offsets into the CURRENT document's
 * serialized markdown (`toMarkdown()` output, LF line endings), plus exact
 * text search with `occurrence` disambiguation. The two APIs deliberately
 * share `findOccurrences`, so a range echoed by setSelection can be handed
 * straight to replaceRanges and vice versa.
 *
 * Inverting the serializer
 * ------------------------
 * `toMarkdown` is the FORWARD map: it splices a CursorMarker into a render
 * block's text at a block-local offset and lets the enclosing scaffolding
 * (list markers, blockquote prefixes, table pipes/padding, code fences) fall
 * around it. There is no closed-form inverse:
 *   - scaffolding occupies markdown offsets that no cursor coordinate can
 *     express (the very reason replaceRanges works on text slices, not cursor
 *     anchors);
 *   - table serialization re-pads columns to their widest cell, so even
 *     probing "where does a marker at offset N land" answers in a frame that
 *     differs from the unmarked document by up to one char per row.
 *
 * So the inversion runs the PARSER — the exact inverse of the serializer, and
 * the same route every user edit already takes (resetTextByUUID_):
 *
 *   1. narrow the absolute offset to the owning top-level child through the
 *      source map ../replace/plan.ts builds (document serialization is a per-child
 *      concat, so the child's local offset is exact by construction);
 *   2. splice a CursorMarker into that child's serialized text at the local
 *      offset and reparse the child. The parser reports {block uuid, block
 *      offset} for the marker — and snaps offsets that landed inside
 *      scaffolding to a legal caret position exactly as it does when a user
 *      types over a list marker;
 *   3. map the freshly parsed block back onto the LIVE tree by ordinal over
 *      render blocks in serialization order. Both trees are enumerated by the
 *      same rule, so the two lists correspond 1:1 as long as the live tree
 *      stays canonical (the block-per-block round-trip invariant asserted by
 *      scripts/verify-replace). The matched block's text is compared before
 *      the position is trusted — a mismatch reports failure rather than
 *      silently placing the caret somewhere plausible-looking.
 */
import { CursorMarker } from "../../constant";
import { DATA_RENDER_ID } from "../../../data-parse/constant";
import { parseMarkdown } from "../../../data-parse/parseMarkdown";
import { CompiledInlineRules } from "../../../data-parse/inline-rules";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
    Token,
} from "../../type";
import {
    findOccurrences,
    ReplaceFailureReason,
    TopLevelSourceMap,
} from "../replace/plan";

// ---------------------------------------------------------------------------
// Public API shapes (stable keys — no `_` suffix, mangle-proof)
// ---------------------------------------------------------------------------

/** Text-match addressing — mirrors TextEdit (replaceText). */
export interface SelectionSearchTarget {
    /** Exact-match needle against the current serialized markdown. */
    search: string;
    /**
     * Disambiguates duplicate matches (0-based, counting non-overlapping
     * matches left to right). Absent + multiple matches → "ambiguous".
     */
    occurrence?: number;
    /**
     * Absent → the selection covers the matched text. "start" / "end" →
     * collapsed caret at the head / tail of the match.
     */
    collapse?: "start" | "end";
}

/** Absolute-offset addressing — mirrors RangeEdit (replaceRanges). */
export interface SelectionRangeTarget {
    /** Absolute offset into the current serialized markdown, inclusive. */
    start: number;
    /** Exclusive end. Omitted or equal to `start` → collapsed caret. */
    end?: number;
}

export type SelectionTarget = SelectionSearchTarget | SelectionRangeTarget;

export interface SelectionResult {
    applied: boolean;
    reason?: ReplaceFailureReason;
    /** Resolved absolute range (echoed for ranges, computed for searches). */
    start?: number;
    end?: number;
}

/** Parser injections threaded from the store so the reparse of step 2 builds
 *  the same tree shape the live document was built with. */
export interface SelectionParseOptions {
    codeTokenizer_?: (code: string, lang?: string) => Token[];
    inlineRules_?: CompiledInlineRules;
    imgGroupSeparators_?: string;
}

type AnyNode = ParentRenderData | RenderData;

export type ResolvedSelection =
    | { start_: number; end_: number }
    | { reason_: ReplaceFailureReason };

// ---------------------------------------------------------------------------
// Target → absolute range
// ---------------------------------------------------------------------------

const isSearchTarget = (
    target: SelectionTarget,
): target is SelectionSearchTarget =>
    (target as SelectionSearchTarget).search !== undefined;

/**
 * Resolve a selection target into an absolute range against `docText`.
 * Failure vocabulary is replaceText's, edit for edit: not_found / ambiguous /
 * occurrence_out_of_range for searches, out_of_bounds for ranges, invalid for
 * malformed input.
 */
export const resolveSelectionTarget = (
    target: SelectionTarget,
    docText: string,
): ResolvedSelection => {
    if (!target || typeof target !== "object") return { reason_: "invalid" };

    if (isSearchTarget(target)) {
        const { search, occurrence, collapse } = target;
        if (
            typeof search !== "string" ||
            search.length === 0 ||
            (occurrence !== undefined &&
                (!Number.isInteger(occurrence) || occurrence < 0)) ||
            (collapse !== undefined &&
                collapse !== "start" &&
                collapse !== "end")
        ) {
            return { reason_: "invalid" };
        }
        const matches = findOccurrences(docText, search);
        if (matches.length === 0) return { reason_: "not_found" };
        let at: number;
        if (occurrence !== undefined) {
            if (occurrence >= matches.length) {
                return { reason_: "occurrence_out_of_range" };
            }
            at = matches[occurrence];
        } else if (matches.length > 1) {
            return { reason_: "ambiguous" };
        } else {
            at = matches[0];
        }
        const head = at;
        const tail = at + search.length;
        if (collapse === "start") return { start_: head, end_: head };
        if (collapse === "end") return { start_: tail, end_: tail };
        return { start_: head, end_: tail };
    }

    const { start, end } = target as SelectionRangeTarget;
    if (
        !Number.isInteger(start) ||
        (end !== undefined && !Number.isInteger(end))
    ) {
        return { reason_: "invalid" };
    }
    const tail = end === undefined ? start : end;
    if (tail < start) return { reason_: "invalid" };
    if (start < 0 || tail > docText.length) return { reason_: "out_of_bounds" };
    return { start_: start, end_: tail };
};

// ---------------------------------------------------------------------------
// Absolute offset → cursor coordinate
// ---------------------------------------------------------------------------

/**
 * Render blocks (DATA_RENDER_ID carriers) in serialization order, INCLUDING
 * nested ones — a code block reports its caret on the Pre while a list reports
 * on the li, and the ordinal mapping only has to be consistent, not minimal.
 *
 * Autofill subtrees are skipped: `toMarkdown` emits them as "" (they are the
 * trailing empty paragraph / list item / row the editor keeps around for the
 * next keystroke), so a fresh parse of the serialization has no counterpart
 * for them. Applying the same rule to both trees is what makes the ordinals
 * line up.
 */
const collectRenderBlocks = (
    node: AnyNode,
    out: AnyNode[],
    inAutoFill: boolean,
): void => {
    const autoFill = inAutoFill || node.isAutoFill_ === true;
    if (autoFill) return;
    if (node.htmlProps_[DATA_RENDER_ID]) out.push(node);
    if (node.children_) {
        for (const child of node.children_) {
            collectRenderBlocks(child, out, autoFill);
        }
    }
};

/** Concatenated `text_` of a subtree — the coordinate space cursor offsets
 *  live in (same pre-order walk as getNodeInfo / withSpanAnchor). */
export const blockTextOf = (node: AnyNode): string => {
    let text = "";
    const visit = (current: AnyNode) => {
        if (typeof current.text_ === "string") {
            text += current.text_;
            return;
        }
        if (current.children_) current.children_.forEach(visit);
    };
    visit(node);
    return text;
};

/**
 * Pick the top-level child that owns `abs`. Separators and autofill children
 * carry no caret position, so they are skipped and the offset attaches to a
 * neighbour: a selection START prefers the next content child (earliest legal
 * position at or after `abs`), an END prefers the previous one (latest legal
 * position at or before `abs`). Offsets that fall between blocks — inside a
 * "\n\n" separator, say — therefore collapse onto the block edge the endpoint
 * is reaching for instead of failing.
 */
const pickChildIndex = (
    map: TopLevelSourceMap,
    children: AnyNode[],
    abs: number,
    affinity: "start" | "end",
): number => {
    const entries = map.entries_;
    const hasBlocks = (index: number): boolean => {
        const child = children[index];
        if (!child) return false;
        const blocks: AnyNode[] = [];
        collectRenderBlocks(child, blocks, false);
        return blocks.length > 0;
    };
    if (affinity === "start") {
        for (let i = 0; i < entries.length; i += 1) {
            if (entries[i].end_ < abs) continue;
            if (hasBlocks(i)) return i;
        }
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            if (hasBlocks(i)) return i;
        }
        return -1;
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].start_ > abs) continue;
        if (hasBlocks(i)) return i;
    }
    for (let i = 0; i < entries.length; i += 1) {
        if (hasBlocks(i)) return i;
    }
    return -1;
};

/**
 * Absolute markdown offset → cursor coordinate (block uuid + in-block offset)
 * against the LIVE tree. Returns null when no caret position can be derived
 * (empty document with no render block, marker swallowed by the reparse, or a
 * live tree that has drifted from its own serialization).
 */
export const resolveOffsetToCursor = (
    root: ParentRenderData | RootRenderData,
    map: TopLevelSourceMap,
    abs: number,
    affinity: "start" | "end",
    options: SelectionParseOptions,
): CursorInfo | null => {
    const children = (root.children_ || []) as AnyNode[];
    const index = pickChildIndex(map, children, abs, affinity);
    if (index === -1) return null;

    const entry = map.entries_[index];
    const child = children[index];
    const local = Math.max(
        0,
        Math.min(entry.text_.length, abs - entry.start_),
    );
    const marked =
        entry.text_.slice(0, local) + CursorMarker + entry.text_.slice(local);

    let found: CursorInfo | null = null;
    const fresh = parseMarkdown(marked, {
        // Last report wins — the same convention resetTextByUUID_ uses when a
        // nested parse re-reports the marker at a deeper block.
        onCursorFound_: (cursorInfo: CursorInfo) => {
            found = cursorInfo;
        },
        codeTokenizer_: options.codeTokenizer_,
        inlineRules_: options.inlineRules_,
        imgGroupSeparators_: options.imgGroupSeparators_,
    });
    const cursor = found as CursorInfo | null;
    if (!cursor) return null;

    const freshBlocks: AnyNode[] = [];
    for (const freshChild of fresh.children_ || []) {
        collectRenderBlocks(freshChild, freshBlocks, false);
    }
    const liveBlocks: AnyNode[] = [];
    collectRenderBlocks(child, liveBlocks, false);

    const ordinal = freshBlocks.findIndex(
        (block) =>
            block.uuid_ === cursor.uuid ||
            block.htmlProps_[DATA_RENDER_ID] === cursor.uuid,
    );
    if (ordinal === -1) return null;
    const live = liveBlocks[ordinal];
    if (!live) return null;

    // Ordinal correspondence is only as good as the live tree's canonicality;
    // verify the block we are about to land on actually holds the same text.
    const liveText = blockTextOf(live);
    if (liveText !== blockTextOf(freshBlocks[ordinal])) return null;

    return {
        uuid: live.uuid_,
        offset: Math.max(0, Math.min(liveText.length, cursor.offset)),
    };
};
