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
 * (offline merge). Online collaboration (provider/awareness) layers on top of
 * this foundation separately.
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
import type {
    CrdtCapableStore,
    RenderDataOp,
    SerializedRenderData,
} from "./types";

/** Transaction origin used when this plugin writes to the doc (for echo detection). */
export const LOCAL_ORIGIN = "domd-crdt-sync-local";

/** Name of the top-level Y.Map that carries the document tree in the doc. */
const ROOT_KEY = "domdRenderData";

export interface CrdtSyncHandle {
    doc: Y.Doc;
    /** The doc's full current state (base64, persistable). */
    getStateBase64(): string;
    /** Fold in an external base64 state (another device / historical persistence); the merged result is flushed back into the store automatically. */
    applyRemoteBase64(base64: string): void;
    /** Detach the mirror (does not destroy the doc). */
    dispose(): void;
}

// ---------------------------------------------------------------------------
// base64 <-> Uint8Array (chunked, as in the old RenderDataStore, to avoid
// blowing the stack on large documents).
// ---------------------------------------------------------------------------

export const uint8ToBase64 = (bytes: Uint8Array): string => {
    const CHUNK_SIZE = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
        binary += String.fromCharCode.apply(
            null,
            chunk as unknown as number[],
        );
    }
    return btoa(binary);
};

export const base64ToUint8 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

// ---------------------------------------------------------------------------
// SerializedRenderData <-> Y structure
// node = Y.Map{type,uuid,text?,mdSymbols,props,tagName?,isAutoFill?,children?}
// children = Y.Array<Y.Map>; props/mdSymbols are whole-value LWW as plain JSON.
// ---------------------------------------------------------------------------

const setScalarFields = (yNode: Y.Map<unknown>, json: SerializedRenderData) => {
    yNode.set("type", json.type);
    yNode.set("uuid", json.uuid);
    yNode.set("mdSymbols", [...json.mdSymbols]);
    yNode.set("props", JSON.parse(JSON.stringify(json.props)));
    if (json.tagName !== undefined) yNode.set("tagName", json.tagName);
    else yNode.delete("tagName");
    if (json.isAutoFill !== undefined) yNode.set("isAutoFill", json.isAutoFill);
    else yNode.delete("isAutoFill");
};

const toYNode = (json: SerializedRenderData): Y.Map<unknown> => {
    const yNode = new Y.Map<unknown>();
    setScalarFields(yNode, json);
    if (json.children) {
        const yChildren = new Y.Array<Y.Map<unknown>>();
        yChildren.insert(0, json.children.map(toYNode));
        yNode.set("children", yChildren);
    } else {
        yNode.set("text", json.text || "");
    }
    return yNode;
};

const yNodeToJSON = (yNode: Y.Map<unknown>): SerializedRenderData =>
    yNode.toJSON() as SerializedRenderData;

// ---------------------------------------------------------------------------
// uuid -> Y.Map registry
// ---------------------------------------------------------------------------

type Registry = Map<string, Y.Map<unknown>>;

const registerSubtree = (yNode: Y.Map<unknown>, registry: Registry) => {
    registry.set(yNode.get("uuid") as string, yNode);
    const children = yNode.get("children") as
        | Y.Array<Y.Map<unknown>>
        | undefined;
    children?.forEach((child) => registerSubtree(child, registry));
};

const unregisterSubtree = (yNode: Y.Map<unknown>, registry: Registry) => {
    registry.delete(yNode.get("uuid") as string);
    const children = yNode.get("children") as
        | Y.Array<Y.Map<unknown>>
        | undefined;
    children?.forEach((child) => unregisterSubtree(child, registry));
};

// ---------------------------------------------------------------------------
// Op application (strictly aligned with core's diffRenderData semantics)
// ---------------------------------------------------------------------------

const applyOp = (
    rootNode: Y.Map<unknown>,
    op: RenderDataOp,
    registry: Registry,
): void => {
    if (op.op === "replaceRoot") {
        unregisterSubtree(rootNode, registry);
        // The root is doc.getMap; it cannot be swapped wholesale — clear it, then rebuild its fields from the new node.
        for (const key of [...rootNode.keys()]) rootNode.delete(key);
        setScalarFields(rootNode, op.node);
        if (op.node.children) {
            const yChildren = new Y.Array<Y.Map<unknown>>();
            yChildren.insert(0, op.node.children.map(toYNode));
            rootNode.set("children", yChildren);
        } else {
            rootNode.set("text", op.node.text || "");
        }
        registerSubtree(rootNode, registry);
        return;
    }
    if (op.op === "insert") {
        const parent = registry.get(op.parent);
        if (!parent) return;
        let children = parent.get("children") as
            | Y.Array<Y.Map<unknown>>
            | undefined;
        if (!children) {
            children = new Y.Array<Y.Map<unknown>>();
            parent.set("children", children);
        }
        const yNode = toYNode(op.node);
        children.insert(Math.min(op.index, children.length), [yNode]);
        registerSubtree(yNode, registry);
        return;
    }
    if (op.op === "delete") {
        const parent = registry.get(op.parent);
        const children = parent?.get("children") as
            | Y.Array<Y.Map<unknown>>
            | undefined;
        if (!children || op.index >= children.length) return;
        unregisterSubtree(children.get(op.index), registry);
        children.delete(op.index, 1);
        return;
    }
    // set
    const target = registry.get(op.uuid);
    if (!target) return;
    switch (op.key) {
        case "children": {
            const prevChildren = target.get("children") as
                | Y.Array<Y.Map<unknown>>
                | undefined;
            prevChildren?.forEach((c) => unregisterSubtree(c, registry));
            if (op.value === null) {
                target.delete("children");
            } else {
                const yChildren = new Y.Array<Y.Map<unknown>>();
                yChildren.insert(
                    0,
                    (op.value as SerializedRenderData[]).map(toYNode),
                );
                target.set("children", yChildren);
                target.delete("text");
                (target.get("children") as Y.Array<Y.Map<unknown>>).forEach(
                    (c) => registerSubtree(c, registry),
                );
            }
            return;
        }
        case "text":
            target.set("text", op.value as string);
            target.delete("children");
            return;
        case "type":
            target.set("type", op.value as string);
            return;
        case "props":
            target.set("props", JSON.parse(JSON.stringify(op.value)));
            return;
        case "mdSymbols":
            target.set("mdSymbols", op.value as string[]);
            return;
        case "tagName":
            if (op.value === undefined) target.delete("tagName");
            else target.set("tagName", op.value as string);
            return;
        case "isAutoFill":
            if (op.value === undefined) target.delete("isAutoFill");
            else target.set("isAutoFill", op.value as boolean);
            return;
        default:
            return;
    }
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AttachCrdtSyncOptions {
    /** An existing doc (e.g. restored from persistence). Omit to create a new one. */
    doc?: Y.Doc;
}

/**
 * Establish a two-way mirror between the store and a Y.Doc.
 * - doc empty: initialize the doc from the store's current content;
 * - doc non-empty: flush the doc's content back into the store (the doc is the
 *   persisted source of truth).
 */
export const attachCrdtSync = (
    store: CrdtCapableStore,
    options: AttachCrdtSyncOptions = {},
): CrdtSyncHandle => {
    const doc = options.doc ?? new Y.Doc();
    const rootNode = doc.getMap<unknown>(ROOT_KEY);
    const registry: Registry = new Map();

    if (rootNode.size === 0) {
        // doc empty -> the store content is the initial state
        const snapshot = store.getRenderDataSnapshot();
        doc.transact(() => {
            setScalarFields(rootNode, snapshot);
            const yChildren = new Y.Array<Y.Map<unknown>>();
            yChildren.insert(0, (snapshot.children || []).map(toYNode));
            rootNode.set("children", yChildren);
        }, LOCAL_ORIGIN);
        registerSubtree(rootNode, registry);
    } else {
        // doc has content -> the doc is the source of truth, flush it back into the store
        registerSubtree(rootNode, registry);
        store.applyExternalRenderData(yNodeToJSON(rootNode));
    }

    // Outbound: op stream -> doc
    const unsubscribeOps = store.subscribeRenderDataOps((ops) => {
        doc.transact(() => {
            for (const op of ops) applyOp(rootNode, op, registry);
        }, LOCAL_ORIGIN);
    });

    // Inbound: updates from a non-local origin (applyRemoteBase64 / provider, etc.) -> store
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
        if (origin === LOCAL_ORIGIN) return;
        // A merge may have rewritten the Y tree structure from the remote side; rebuild the whole registry.
        registry.clear();
        registerSubtree(rootNode, registry);
        store.applyExternalRenderData(yNodeToJSON(rootNode));
    };
    doc.on("update", onUpdate);

    return {
        doc,
        getStateBase64: () => {
            // Flush in-flight input bursts before snapshotting, so the published state contains everything typed.
            store.flushPendingInput?.();
            return uint8ToBase64(Y.encodeStateAsUpdate(doc));
        },
        applyRemoteBase64: (base64: string) => {
            // Flush before merging: any unsaved burst goes into model+doc first (through the op stream),
            // otherwise the whole-tree flush after the merge would wash it out along with the DOM.
            store.flushPendingInput?.();
            Y.applyUpdate(doc, base64ToUint8(base64), "remote");
        },
        dispose: () => {
            unsubscribeOps();
            doc.off("update", onUpdate);
        },
    };
};

/** Restore a Y.Doc from a base64 state (pair with attachCrdtSync({doc}) to load a document). */
export const docFromBase64 = (base64: string): Y.Doc => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToUint8(base64), "remote");
    return doc;
};

/** Merge two base64 states offline (no store needed — a pure data-layer merge). */
export const mergeBase64States = (a: string, b: string): string =>
    uint8ToBase64(Y.mergeUpdates([base64ToUint8(a), base64ToUint8(b)]));
