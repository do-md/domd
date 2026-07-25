/**
 * CRDT sync plugin: mirrors DOMD core's RenderDataOp stream into a Y.Doc.
 *
 * Architecture (see the header comment of core's src/editor/sync/index.ts):
 * - Outbound: store.subscribeRenderDataOps -> a minimal op stream (span
 *   granularity: a single typing burst is usually one insert op) -> this plugin
 *   applies it to the Y.Doc via a uuid registry + Y.Array splice semantics
 *   (transact, origin = LOCAL_ORIGIN).
 * - Inbound: an external update (another device's merge / a persisted load)
 *   enters the doc through Y.applyUpdate -> this plugin listens for updates from
 *   a non-local origin -> the whole tree is flushed back into the store
 *   (applyExternalRenderData: no undo entry, emits no op, so there is no echo).
 * - Concurrency: a span is an immutable atom (core's span-preserving diff
 *   guarantees only create/delete). Two sides editing different spans of the
 *   same paragraph -> their inserts/deletes merge without conflict on the
 *   Y.Array; editing the same span concurrently -> both delete+insert survive
 *   (a duplicate but no lost text — visible and editable, better than a silent
 *   LWW loss).
 *
 * v1 scope: CRDT as a mergeable persistence / multi-device sync data layer
 * (offline merge, whole-tree flush-back). Realtime collaboration (op-level
 * inbound + presence) lives in collaboration/realtime-sync.
 *
 * Shared-origin discipline: docs taking part in a merge must come from the same
 * creation (created on one side, its bytes cloned to the others). When two
 * *independently created* docs (same content/uuid but different Yjs item
 * identities) are merged, the conflict lands as a concurrent set on the
 * top-level Y.Map = whole-value LWW — the loser's entire tree is *silently
 * lost* (not a duplication, which is more dangerous). Before attaching, callers
 * must restore the existing doc from persistence rather than rebuild an empty
 * doc and refill it.
 */
import * as Y from "yjs";
import type { CrdtCapableStore } from "./types";
import {
    ROOT_KEY,
    Registry,
    applyOpToY,
    base64ToUint8,
    registerSubtree,
    setScalarFields,
    toYNode,
    uint8ToBase64,
    yNodeToJSON,
} from "./y-mapping";

/** Transaction origin used when this plugin writes to the doc (for echo detection). */
export const LOCAL_ORIGIN = "domd-crdt-sync-local";

export interface CrdtSyncHandle {
    doc: Y.Doc;
    /** The doc's full current state (base64, persistable). */
    getStateBase64(): string;
    /** Fold in an external base64 state (another device / historical persistence); the merged result is flushed back into the store automatically. */
    applyRemoteBase64(base64: string): void;
    /** Detach the mirror (does not destroy the doc). */
    dispose(): void;
}

export interface AttachCrdtSyncOptions {
    /** An existing doc (e.g. restored from persistence). Omit to create a new one. */
    doc?: Y.Doc;
}

/**
 * Establish a two-way mirror between the store and a Y.Doc.
 * - Empty doc: initialize the doc from the store's current content.
 * - Non-empty doc: flush the doc's content back into the store (the doc is
 *   the persisted source of truth).
 */
export const attachCrdtSync = (
    store: CrdtCapableStore,
    options: AttachCrdtSyncOptions = {},
): CrdtSyncHandle => {
    const doc = options.doc ?? new Y.Doc();
    const rootNode = doc.getMap<unknown>(ROOT_KEY);
    const registry: Registry = new Map();

    if (rootNode.size === 0) {
        // Empty doc -> the store's content is the initial state.
        const snapshot = store.getRenderDataSnapshot();
        doc.transact(() => {
            setScalarFields(rootNode, snapshot);
            const yChildren = new Y.Array<Y.Map<unknown>>();
            yChildren.insert(0, (snapshot.children || []).map(toYNode));
            rootNode.set("children", yChildren);
        }, LOCAL_ORIGIN);
        registerSubtree(rootNode, registry);
    } else {
        // Non-empty doc -> the doc is the source of truth; flush it back.
        registerSubtree(rootNode, registry);
        store.applyExternalRenderData(yNodeToJSON(rootNode));
    }

    // Outbound: op stream -> doc.
    const unsubscribeOps = store.subscribeRenderDataOps((ops) => {
        doc.transact(() => {
            for (const op of ops) applyOpToY(rootNode, op, registry);
        }, LOCAL_ORIGIN);
    });

    // Inbound: updates from a non-local origin (applyRemoteBase64 / a provider) -> store.
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
        if (origin === LOCAL_ORIGIN) return;
        // A merge may have rewritten the Y tree structure remotely; rebuild the registry wholesale.
        registry.clear();
        registerSubtree(rootNode, registry);
        store.applyExternalRenderData(yNodeToJSON(rootNode));
    };
    doc.on("update", onUpdate);

    return {
        doc,
        getStateBase64: () => {
            // Flush any in-flight typing burst first so the published state contains everything typed.
            store.flushPendingInput?.();
            return uint8ToBase64(Y.encodeStateAsUpdate(doc));
        },
        applyRemoteBase64: (base64: string) => {
            // Flush before merging: an unflushed burst must enter model+doc
            // (via the op stream) first, otherwise the post-merge whole-tree
            // flush-back would wash it away together with the DOM.
            store.flushPendingInput?.();
            Y.applyUpdate(doc, base64ToUint8(base64), "remote");
        },
        dispose: () => {
            unsubscribeOps();
            doc.off("update", onUpdate);
        },
    };
};

/** Restore a Y.Doc from a base64 state (pass to attachCrdtSync({doc}) to load a document). */
export const docFromBase64 = (base64: string): Y.Doc => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToUint8(base64), "remote");
    return doc;
};

/** Merge two base64 states offline (pure data-layer merge, no store needed). */
export const mergeBase64States = (a: string, b: string): string =>
    uint8ToBase64(Y.mergeUpdates([base64ToUint8(a), base64ToUint8(b)]));

export { uint8ToBase64, base64ToUint8 } from "./y-mapping";
