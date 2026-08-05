import type { EditorStoreApi } from "@do-md/core-react";

/**
 * Block-insert methods that ship in the @do-md/core-react 0.8.0 runtime
 * bundle but are missing from its published `EditorStoreApi` typings (both
 * are plain public store methods — insertTable drops a 2x2 table, and
 * insertCheckList drops "- [ ] ", each creating a fresh top-level block when
 * the caret is not on an empty paragraph). Cast through this until the
 * typings catch up, then delete this file.
 */
export interface EditorStoreInsertOps {
    insertTable(): void;
    insertCheckList(): void;
}

export type EditorStoreWithInserts = EditorStoreApi & EditorStoreInsertOps;
