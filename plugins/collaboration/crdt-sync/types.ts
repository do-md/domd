/**
 * Stable types aligned with @do-md/core-react's public sync seam.
 *
 * These are declared *locally* on purpose rather than imported from the package:
 * 1. they are the public JSON contract core promises to keep stable across
 *    versions (minification-immune stable keys);
 * 2. the plugin types the store structurally (it depends on only three
 *    methods), decoupling it from the core version — any core in node_modules
 *    upgraded to a version with the sync API satisfies this automatically.
 *
 * If core's contract changes (it should not), sync this file against core's
 * types/index.d.ts.
 */

export interface SerializedRenderData {
    type: string;
    uuid: string;
    mdSymbols: string[];
    props: Record<string, unknown>;
    tagName?: string;
    isAutoFill?: boolean;
    /** Leaf text; mutually exclusive with children. */
    text?: string;
    /** Container children; mutually exclusive with text. */
    children?: SerializedRenderData[];
}

export type RenderDataOp =
    | {
          op: "insert";
          parent: string;
          index: number;
          node: SerializedRenderData;
      }
    | { op: "delete"; parent: string; index: number }
    | {
          op: "set";
          uuid: string;
          key:
              | "type"
              | "text"
              | "props"
              | "mdSymbols"
              | "tagName"
              | "isAutoFill"
              | "children";
          value: unknown;
      }
    | { op: "replaceRoot"; node: SerializedRenderData };

/** One cursor endpoint: block uuid + in-block offset, plus an optional
 *  span-level anchor (smallest text leaf). Anchored cursors survive remote
 *  edits elsewhere in the same block — resolve them through
 *  `resolveCursorPosition` before DOM positioning. Cores that predate span
 *  anchoring simply omit the span fields. */
export interface CursorPosition {
    uuid: string;
    offset: number;
    spanUuid?: string;
    spanOffset?: number;
}

/** Local-cursor snapshot (aligned with core's public CursorSnapshot shape). */
export interface CursorSnapshot {
    start: CursorPosition | null;
    end: CursorPosition | null;
}

/**
 * The minimal store surface the plugin needs (EditorStoreApi is a superset of
 * this interface). Structurally matched — it does not require the nominal
 * EditorStore type.
 */
export interface CrdtCapableStore {
    subscribeRenderDataOps(
        listener: (ops: RenderDataOp[]) => void,
    ): () => void;
    getRenderDataSnapshot(): SerializedRenderData;
    applyExternalRenderData(json: SerializedRenderData): void;
    /**
     * Flush unsaved input bursts from speculative rendering (a no-op when there
     * is nothing pending). Optional — the plugin gracefully skips it on older
     * cores without this method.
     */
    flushPendingInput?(): void;
    /**
     * Realtime hot path: surgically apply a remote op batch (O(change)
     * rendering). Provided by core >=0.4.0; realtime-sync requires it.
     */
    applyExternalRenderDataOps?(ops: RenderDataOp[]): void;
    /** Local cursor snapshot (awareness OUT direction). core >=0.4.0. */
    getCursorSnapshot?(): CursorSnapshot;
    /** Subscribe to local cursor changes. core >=0.4.0. */
    subscribeCursorChange?(
        listener: (cursor: CursorSnapshot) => void,
    ): () => void;
    /** Resolve a (possibly span-anchored) peer cursor against the CURRENT
     *  local tree into block-level coordinates for DOM positioning. Null =
     *  the block is gone, don't draw. Optional — on older cores callers fall
     *  back to the raw uuid+offset. core >=0.4.2. */
    resolveCursorPosition?(
        cursor: CursorPosition,
    ): { uuid: string; offset: number } | null;
}
