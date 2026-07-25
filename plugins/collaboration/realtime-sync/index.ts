/**
 * Realtime collaboration plugin: live multi-user sync of one document plus
 * presence (remote carets).
 *
 * Difference from crdt-sync (offline merge, whole-tree flush-back): the
 * inbound direction here is an **op-level replay hot path** — Y.Doc
 * observeDeep events -> translateYEvents -> core applyExternalRenderDataOps
 * (immer creates new objects only for touched paths -> memo hits everywhere
 * else -> O(change) rendering), so each remote keystroke re-renders only the
 * spans it actually changed.
 *
 * The transport is abstracted as RealtimeTransport (default:
 * BroadcastChannel — cross-tab / multi-instance within one browser; swapping
 * in WebSocket/WebRTC only requires implementing the same interface).
 *
 * Presence: the local caret is broadcast via core's subscribeCursorChange
 * (uuid+offset addressing); remote peers (caret/name/color/heartbeat) live
 * **only inside this plugin** and are drawn by the RemoteCursors component —
 * core stays collaboration-agnostic and only exposes its own caret.
 *
 * Shared-origin discipline (same as crdt-sync): docs must share one origin.
 * Prefer restoring from persistence before attaching; for a fresh session the
 * first client creates the doc and hands it to latecomers via the state
 * handshake.
 */
import * as Y from "yjs";
import type {
    CrdtCapableStore,
    CursorSnapshot,
} from "../crdt-sync/types";
import {
    ROOT_KEY,
    Registry,
    applyOpToY,
    registerSubtree,
    setScalarFields,
    toYNode,
    uint8ToBase64,
    yNodeToJSON,
} from "../crdt-sync/y-mapping";
import { translateYEvents } from "./translate";

export const LOCAL_ORIGIN = "domd-realtime-local";
export const REMOTE_ORIGIN = "domd-realtime-remote";

const HEARTBEAT_MS = 4000;
const PEER_TTL_MS = 12000;
const CURSOR_THROTTLE_MS = 80;

// ---------------------------------------------------------------------------
// Transport abstraction (default: BroadcastChannel; inject a WebSocket
// adapter or an in-memory channel for tests).
// ---------------------------------------------------------------------------

export interface RealtimeTransport {
    post(message: unknown): void;
    onMessage(handler: (message: unknown) => void): () => void;
    close(): void;
}

export const createBroadcastChannelTransport = (
    room: string,
): RealtimeTransport => {
    const channel = new BroadcastChannel(`domd-realtime:${room}`);
    return {
        post: (message) => channel.postMessage(message),
        onMessage: (handler) => {
            const listener = (e: MessageEvent) => handler(e.data);
            channel.addEventListener("message", listener);
            return () => channel.removeEventListener("message", listener);
        },
        close: () => channel.close(),
    };
};

// ---------------------------------------------------------------------------
// Wire protocol.
// ---------------------------------------------------------------------------

type WireMessage =
    | { t: "u"; from: string; u: Uint8Array } // incremental update
    | { t: "hello"; from: string } // newcomer: request full state + announce
    | { t: "state"; from: string; u: Uint8Array } // full-state reply
    | {
          t: "cursor";
          from: string;
          name: string;
          color: string;
          cursor: CursorSnapshot | null;
      }
    | { t: "bye"; from: string };

export interface RealtimePeer {
    clientId: string;
    name: string;
    color: string;
    cursor: CursorSnapshot | null;
    lastSeen: number;
}

export interface AttachRealtimeSyncOptions {
    room: string;
    clientId?: string;
    name?: string;
    color?: string;
    /** An existing doc (restored from persistence). Omit to create a new one (becoming this session's document origin). */
    doc?: Y.Doc;
    /** Transport injection (default: BroadcastChannel(room)). */
    transport?: RealtimeTransport;
}

export interface RealtimeSyncHandle {
    doc: Y.Doc;
    clientId: string;
    /** The doc's full current state (base64, for persisting the shared origin). */
    getStateBase64(): string;
    getPeers(): RealtimePeer[];
    subscribePeers(listener: (peers: RealtimePeer[]) => void): () => void;
    dispose(): void;
}

// ---------------------------------------------------------------------------

const randomId = () => Math.random().toString(36).slice(2, 10);

export const attachRealtimeSync = (
    store: CrdtCapableStore,
    options: AttachRealtimeSyncOptions,
): RealtimeSyncHandle => {
    if (typeof store.applyExternalRenderDataOps !== "function") {
        throw new Error(
            "[realtime-sync] store.applyExternalRenderDataOps missing — " +
                "requires @do-md/core-react >= 0.4.0",
        );
    }
    const clientId = options.clientId ?? randomId();
    const name = options.name ?? `user-${clientId.slice(0, 4)}`;
    const color = options.color ?? "#8a7aa8";
    const doc = options.doc ?? new Y.Doc();
    const transport =
        options.transport ?? createBroadcastChannelTransport(options.room);

    const rootNode = doc.getMap<unknown>(ROOT_KEY);
    const registry: Registry = new Map();

    // ---- Initialization: same discipline as crdt-sync ----
    if (rootNode.size === 0) {
        const snapshot = store.getRenderDataSnapshot();
        doc.transact(() => {
            setScalarFields(rootNode, snapshot);
            const yChildren = new Y.Array<Y.Map<unknown>>();
            yChildren.insert(0, (snapshot.children || []).map(toYNode));
            rootNode.set("children", yChildren);
        }, LOCAL_ORIGIN);
        registerSubtree(rootNode, registry);
    } else {
        registerSubtree(rootNode, registry);
        store.applyExternalRenderData(yNodeToJSON(rootNode)); // one-off O(doc) bootstrap
    }

    // ---- Outbound: local ops -> doc ----
    const unsubscribeOps = store.subscribeRenderDataOps((ops) => {
        doc.transact(() => {
            for (const op of ops) applyOpToY(rootNode, op, registry);
        }, LOCAL_ORIGIN);
    });

    // ---- Inbound: remote transactions -> op-level replay (hot path) ----
    const onDeepEvents = (
        events: Y.YEvent<Y.AbstractType<unknown>>[],
        tx: Y.Transaction,
    ) => {
        if (tx.origin === LOCAL_ORIGIN) return;
        const ops = translateYEvents(events);
        // A remote peer may insert/delete subtrees; rebuild the registry
        // wholesale (v1 simplification; switch to incremental per-event
        // maintenance for high-frequency large documents).
        registry.clear();
        registerSubtree(rootNode, registry);
        if (ops.length) store.applyExternalRenderDataOps!(ops);
    };
    rootNode.observeDeep(onDeepEvents);

    // ---- Transport: broadcast locally produced updates ----
    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE_ORIGIN) return; // do not echo remote updates back
        transport.post({ t: "u", from: clientId, u: update } as WireMessage);
    };
    doc.on("update", onDocUpdate);

    // ---- Presence ----
    const peers = new Map<string, RealtimePeer>();
    const peerListeners = new Set<(peers: RealtimePeer[]) => void>();
    const notifyPeers = () => {
        const list = [...peers.values()];
        peerListeners.forEach((l) => l(list));
    };

    // Only broadcast carets that core deems safe to publish
    // (subscribeCursorChange guarantees text-before-caret causal order);
    // heartbeats and handshake replies reuse the last legal value and never
    // read the live snapshot directly — during speculative input the live
    // snapshot's offset points at text the remote side does not have yet.
    let lastCursor: CursorSnapshot | null =
        store.getCursorSnapshot?.() ?? null;
    let lastCursorPost = 0;
    let cursorTimer: ReturnType<typeof setTimeout> | undefined;
    const postCursor = () => {
        transport.post({
            t: "cursor",
            from: clientId,
            name,
            color,
            cursor: lastCursor,
        } as WireMessage);
        lastCursorPost = Date.now();
    };
    const postCursorThrottled = () => {
        const wait = CURSOR_THROTTLE_MS - (Date.now() - lastCursorPost);
        if (wait <= 0) {
            postCursor();
            return;
        }
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(postCursor, wait);
    };
    const unsubscribeCursor =
        store.subscribeCursorChange?.((cursor) => {
            lastCursor = cursor;
            postCursorThrottled();
        }) ?? (() => {});

    // Heartbeat (also evicts timed-out peers).
    const heartbeat = setInterval(() => {
        postCursor();
        const now = Date.now();
        let changed = false;
        for (const [id, peer] of peers) {
            if (now - peer.lastSeen > PEER_TTL_MS) {
                peers.delete(id);
                changed = true;
            }
        }
        if (changed) notifyPeers();
    }, HEARTBEAT_MS);

    // ---- Message handling ----
    const unsubscribeTransport = transport.onMessage((raw) => {
        const msg = raw as WireMessage;
        if (!msg || msg.from === clientId) return;
        switch (msg.t) {
            case "u":
                store.flushPendingInput?.();
                Y.applyUpdate(doc, msg.u, REMOTE_ORIGIN);
                return;
            case "hello":
                // Newcomer: hand over the full state and announce ourselves.
                transport.post({
                    t: "state",
                    from: clientId,
                    u: Y.encodeStateAsUpdate(doc),
                } as WireMessage);
                postCursor();
                return;
            case "state":
                store.flushPendingInput?.();
                Y.applyUpdate(doc, msg.u, REMOTE_ORIGIN);
                return;
            case "cursor":
                peers.set(msg.from, {
                    clientId: msg.from,
                    name: msg.name,
                    color: msg.color,
                    cursor: msg.cursor,
                    lastSeen: Date.now(),
                });
                notifyPeers();
                return;
            case "bye":
                if (peers.delete(msg.from)) notifyPeers();
                return;
            default:
                return;
        }
    });

    // Join handshake.
    transport.post({ t: "hello", from: clientId } as WireMessage);
    postCursor();

    return {
        doc,
        clientId,
        getStateBase64: () => {
            store.flushPendingInput?.();
            return uint8ToBase64(Y.encodeStateAsUpdate(doc));
        },
        getPeers: () => [...peers.values()],
        subscribePeers: (listener) => {
            peerListeners.add(listener);
            listener([...peers.values()]);
            return () => {
                peerListeners.delete(listener);
            };
        },
        dispose: () => {
            transport.post({ t: "bye", from: clientId } as WireMessage);
            clearInterval(heartbeat);
            clearTimeout(cursorTimer);
            unsubscribeCursor();
            unsubscribeOps();
            rootNode.unobserveDeep(onDeepEvents);
            doc.off("update", onDocUpdate);
            unsubscribeTransport();
            transport.close();
        },
    };
};
