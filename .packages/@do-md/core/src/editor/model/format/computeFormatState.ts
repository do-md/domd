import { MarkdownType } from "../../type/enum";
import {
    FormatState,
    InlineFormatMark,
    ParentRenderData,
} from "../../type";
import { normalizeRichCursorOffset } from "../rich/normalizeRichCursorOffset";
import { getRenderDataById } from "../tree/getRenderDataById";
import { MARK_ORDER } from "./marks";
import { decomposeInlineItems } from "./inlineItems";
import { inlineFormatHasStarConflict } from "./inlineFormatHasStarConflict";

/**
 * Derive the reactive formatting state for a cursor/selection (the state that
 * backs `EditorStore.formatState` / `useFormatState()`). Pure function of
 * (tree, cursor, pending) — mirrors `format()`'s own gating exactly, so
 * `can: true` means a `format(mark)` call will not be swallowed:
 * - collapsed caret → `active` = marks of the char before the caret (char
 *   after at block start), or marks ARMED here via pendingMarks; `can` for an
 *   inactive mark = it can be armed (`*`-family marks blocked inside another
 *   `*` construct); `can` for an active mark = the caret sits at the
 *   construct tail and format() would EXIT it (hop past the closes);
 * - single-block range → `active` = every token carries the mark
 *   (isInlineRangeFullyMarked semantics), `can` gated on non-empty token
 *   range + highlight rule availability + no `*`-delimiter conflict for the
 *   direction the toggle would take;
 * - no cursor / unknown block / cross-block range / code block → all
 *   inactive, nothing can (v1 format engine is single-block, code blocks
 *   have no inline marks).
 */
export const computeFormatState = (
    root: ParentRenderData,
    start: { uuid: string; offset: number } | null,
    end: { uuid: string; offset: number } | null,
    hasHighlight: boolean,
    /** Pending formatting, armed by a collapsed format() call. While its
     *  anchor matches the current collapsed cursor it reads as active (the
     *  button lights up the instant it is clicked) and as can (a second click
     *  disarms it). */
    pendingMarks?: { anchorUuid_: string; anchorOffset_: number; marks_: InlineFormatMark[] } | null,
): FormatState => {
    const state = {} as FormatState;
    for (const mark of MARK_ORDER) {
        state[mark] = { active: false, can: false };
    }

    if (!start) return state;
    const block = getRenderDataById(start.uuid, root) as
        | ParentRenderData
        | undefined;
    if (!block) return state;
    // Code blocks carry no inline marks — formatting there would write
    // literal delimiters into code. (PreCode is the caret-addressable block;
    // Pre is its container, guarded for coordinate robustness.)
    if (
        block.htmlType_ === MarkdownType.PreCode ||
        block.htmlType_ === MarkdownType.PreCodeEmpty ||
        block.htmlType_ === MarkdownType.Pre
    ) {
        return state;
    }

    const isRange =
        !!end && (end.uuid !== start.uuid || end.offset !== start.offset);

    if (!isRange) {
        // Collapsed caret. `active` = the marks the caret "sits in" — the
        // char before it (editor convention), falling back to the char after
        // at block start.
        const items = decomposeInlineItems(block);
        const at =
            items.find(
                (it) =>
                    it.sp < start.offset && it.sp + it.len >= start.offset,
            ) ??
            items.find(
                (it) =>
                    it.sp <= start.offset && it.sp + it.len > start.offset,
            );
        const marksHere = at?.marks ?? new Set<InlineFormatMark>();
        const inStarConstruct =
            marksHere.has("bold") || marksHere.has("italic");
        // Construct-tail probe: only closing symbols between the caret and
        // the outside → an active mark can be EXITED here (caret hops past
        // the closes, typing continues unformatted). Same function format()
        // jumps with, so can ⟺ behaviour stays sourced from one place.
        const atConstructTail =
            normalizeRichCursorOffset(block, start.offset) > start.offset;
        const armedHere =
            pendingMarks &&
            pendingMarks.anchorUuid_ === start.uuid &&
            pendingMarks.anchorOffset_ === start.offset
                ? pendingMarks.marks_
                : null;
        for (const mark of MARK_ORDER) {
            // Armed marks read active before anything is typed (the toolbar
            // lights up on click); can stays true — a second click disarms.
            if (armedHere?.includes(mark)) {
                state[mark] = { active: true, can: true };
                continue;
            }
            const active = marksHere.has(mark);
            const can = active
                ? // toggle OFF collapsed = exit at the construct tail;
                  // mid-content still needs a selection (strip)
                  atConstructTail
                : (mark !== "highlight" || hasHighlight) &&
                  // empty `*` pairs inside `*` constructs mis-nest
                  // (`*i**|**t*`) — same greedy-`*` family the range path
                  // guards via inlineFormatHasStarConflict
                  !((mark === "bold" || mark === "italic") && inStarConstruct);
            state[mark] = { active, can };
        }
        return state;
    }

    if (end!.uuid !== start.uuid) return state; // cross-block: engine is v1 single-block

    const lo = Math.min(start.offset, end!.offset);
    const hi = Math.max(start.offset, end!.offset);
    const inRange = decomposeInlineItems(block).filter(
        (it) => it.sp < hi && it.sp + it.len > lo,
    );
    if (!inRange.length) return state;

    for (const mark of MARK_ORDER) {
        const active = inRange.every((it) => it.marks.has(mark));
        const can =
            (mark !== "highlight" || hasHighlight) &&
            !inlineFormatHasStarConflict(block, lo, hi, {
                mark,
                op: active ? "strip" : "add",
            });
        state[mark] = { active, can };
    }
    return state;
};
