/**
 * Structural insert commands.
 *
 * These used to be kernel methods (`insertTable`, `insertCheckList`,
 * `insertCodeArea`). They are rebuilt here on the public primitives —
 * `getSelectionOffsets` to find the caret, `replaceRanges` to write, and
 * `setSelection` to land the caret — so the kernel keeps only mechanism and
 * every named command lives in one layer.
 *
 * The landing contract is the kernel's, preserved verbatim:
 *   - an empty paragraph is a legal insertion point, and the block replaces it
 *     in place;
 *   - a caret inside real content may not be split, so the block goes AFTER
 *     the caret's top-level line and becomes a new block;
 *   - one call is one undo step (a single `replaceRanges` batch);
 *   - after a table the caret lands in the first cell.
 */

import type { EditorStoreApi } from "@do-md/core-react";
import { activeGuard, blockInsertOffset, blockPadding, readTarget } from "./target";

/**
 * A 2x2 empty table: a header row, the alignment row, and one body row. This
 * is byte-for-byte what the kernel's retired `insertTable()` produced once its
 * cursor marker was stripped, so documents authored before and after the move
 * are identical.
 */
const TABLE_SNIPPET = "|  |  |\n| --- | --- |\n|  |  |";

/** Offset of the first header cell's content, relative to the snippet: past
 *  the opening `| ` of `|  |  |`. Offsets that land in serialization
 *  scaffolding snap to the nearest legal caret slot, so this only has to be
 *  close; it is exact. */
const TABLE_FIRST_CELL_OFFSET = 2;

/**
 * Insert an empty 2x2 table at the caret and put the caret in its first cell.
 */
export function insertTable(store: EditorStoreApi | null): void {
    const target = readTarget(store);
    if (!store || !target) return;
    // Tables don't nest, a fence would render the pipes as code, and splitting
    // a rule is meaningless — all three refuse rather than corrupt.
    if (activeGuard(target)) return;
    const at = blockInsertOffset(target);
    const { lead, trail } = blockPadding(target.md, at);
    const text = lead + TABLE_SNIPPET + trail;
    store.replaceRanges({ start: at, end: at, text });
    store.setSelection({
        start: at + lead.length + TABLE_FIRST_CELL_OFFSET,
    });
}
