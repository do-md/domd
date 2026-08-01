/**
 * Text diff -> kernel RangeEdit[] converter.
 *
 * Feeds the kernel's batch replace primitive (store.replaceRanges): given the
 * CURRENT serialized markdown and an external target version, produce
 * non-overlapping, ascending {start, end, text} edits in current-text
 * coordinates that transform current into target.
 *
 * diff-match-patch with semantic cleanup keeps the ranges tight (untouched
 * regions keep their span identity through the kernel's scoped reparse) while
 * coalescing noisy char-level fragments.
 */
import {
    DIFF_DELETE,
    DIFF_INSERT,
    diff_match_patch,
} from "diff-match-patch";
import type { RangeEdit } from "@do-md/core-react";

export const computeRangeEdits = (
    current: string,
    target: string,
): RangeEdit[] => {
    if (current === target) return [];
    const dmp = new diff_match_patch();
    // Large docs: give the diff enough headroom before it falls back to a
    // coarse (but still correct) result.
    dmp.Diff_Timeout = 2;
    const diffs = dmp.diff_main(current, target);
    dmp.diff_cleanupSemantic(diffs);

    const edits: RangeEdit[] = [];
    let pos = 0; // cursor in `current` coordinates
    let pending: RangeEdit | null = null;

    const flush = () => {
        if (pending) edits.push(pending);
        pending = null;
    };

    for (const [op, text] of diffs) {
        if (op === DIFF_DELETE) {
            if (pending && pending.end === pos) {
                pending.end = pos + text.length;
            } else {
                flush();
                pending = { start: pos, end: pos + text.length, text: "" };
            }
            pos += text.length;
        } else if (op === DIFF_INSERT) {
            if (pending && pending.end === pos) {
                pending.text += text;
            } else {
                flush();
                pending = { start: pos, end: pos, text };
            }
        } else {
            flush();
            pos += text.length;
        }
    }
    flush();
    return edits;
};
