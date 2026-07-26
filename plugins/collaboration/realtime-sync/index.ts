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
    /** Optional targeted delivery for transports with per-peer links (e.g.
     *  WebRTC data channels). Falls back to broadcast when absent. */
    postTo?(peerId: string, message: unknown): void;
    onMessage(handler: (message: unknown) => void): () => void;
    /** Optional peer-link lifecycle. `peerId` MUST equal the remote side's
     *  realtime clientId (pass one shared id to both the transport and
     *  attachRealtimeSync) so targeted replies reach the right link. */
    onPeerConnect?(handler: (peerId: string) => void): () => void;
    onPeerDisconnect?(handler: (peerId: string) => void): () => void;
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
    | { t: "bye"; from: string }
    // Room dissolution broadcast (host action). Receivers surface it via the
    // onRoomClosed option; the plugin itself does not dispose — the caller
    // decides (e.g. keep editing locally, drop persistence, show a notice).
    | { t: "close"; from: string };

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
    /** Called when a peer broadcasts room dissolution (wire message "close"). */
    onRoomClosed?: (from: string) => void;
    /**
     * Receive-only (viewer) mode. The session applies remote updates and
     * tracks remote presence but never emits edits ("u") or presence
     * ("cursor"/"bye") — viewers stay out of every peer list. It still
     * answers "hello"/peer-connect with "state": serving the doc keeps the
     * mesh bootstrappable (a stale editor reconnecting against only viewers
     * must still converge) and state messages never create peer entries.
     */
    readonly?: boolean;
}

export interface RealtimeSyncHandle {
    doc: Y.Doc;
    clientId: string;
    /** The doc's full current state (base64, for persisting the shared origin). */
    getStateBase64(): string;
    getPeers(): RealtimePeer[];
    subscribePeers(listener: (peers: RealtimePeer[]) => void): () => void;
    /** Broadcast room dissolution to every peer (host action). Does not
     *  dispose — call dispose() afterwards. */
    closeRoom(): void;
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
    const readonly = options.readonly === true;
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

    // ---- Outbound: local ops -> doc (viewers never edit; skip entirely) ----
    const unsubscribeOps = readonly
        ? () => {}
        : store.subscribeRenderDataOps((ops) => {
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
        if (readonly) return; // viewers never push edits
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
        if (readonly) return; // viewers have no presence
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
    const unsubscribeCursor = readonly
        ? () => {}
        : (store.subscribeCursorChange?.((cursor) => {
              lastCursor = cursor;
              postCursorThrottled();
          }) ?? (() => {}));

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
            case "close":
                options.onRoomClosed?.(msg.from);
                return;
            default:
                return;
        }
    });

    // ---- Peer-link lifecycle (transports with real per-peer connectivity,
    // e.g. WebRTC data channels). When a link opens, hand the peer our full
    // state — both sides do this symmetrically, which covers newcomers AND
    // reconnects after offline editing in one mechanism (Y.applyUpdate merges
    // are idempotent and commutative). Without these hooks (BroadcastChannel)
    // the hello/state handshake below covers the same ground.
    const postTargeted = (peerId: string, message: WireMessage) => {
        if (transport.postTo) transport.postTo(peerId, message);
        else transport.post(message);
    };
    const unsubscribePeerConnect =
        transport.onPeerConnect?.((peerId) => {
            store.flushPendingInput?.();
            postTargeted(peerId, {
                t: "state",
                from: clientId,
                u: Y.encodeStateAsUpdate(doc),
            });
            if (readonly) return; // no presence announcement
            postTargeted(peerId, {
                t: "cursor",
                from: clientId,
                name,
                color,
                cursor: lastCursor,
            });
        }) ?? (() => {});
    const unsubscribePeerDisconnect =
        transport.onPeerDisconnect?.((peerId) => {
            if (peers.delete(peerId)) notifyPeers();
        }) ?? (() => {});

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
        closeRoom: () => {
            transport.post({ t: "close", from: clientId } as WireMessage);
        },
        dispose: () => {
            if (!readonly) {
                // Viewers never announced themselves — no bye to send.
                transport.post({ t: "bye", from: clientId } as WireMessage);
            }
            clearInterval(heartbeat);
            clearTimeout(cursorTimer);
            unsubscribeCursor();
            unsubscribePeerConnect();
            unsubscribePeerDisconnect();
            unsubscribeOps();
            rootNode.unobserveDeep(onDeepEvents);
            doc.off("update", onDocUpdate);
            unsubscribeTransport();
            transport.close();
        },
    };
};

// ---------------------------------------------------------------------------
// Initial-state fetch (no store attached).
// ---------------------------------------------------------------------------

/**
 * One-shot full-state fetch over a transport WITHOUT attaching a store. Used
 * by a first-time joiner that has no local doc yet: obtaining the origin
 * doc's bytes BEFORE creating the editor preserves the shared-origin
 * discipline (attaching an empty local store first would mint independent
 * Yjs item identities and fork the origin).
 *
 * Resolves with the first full state received from any peer, or null once
 * the abort signal fires. The caller owns the transport (it is NOT closed
 * here — reuse it for attach, or close it and reconnect with a stable id).
 */
export const fetchInitialState = (
    transport: RealtimeTransport,
    options?: { signal?: AbortSignal },
): Promise<Uint8Array | null> =>
    new Promise((resolve) => {
        const tempId = randomId();
        let done = false;
        let unsubMessage = () => {};
        let unsubPeer = () => {};
        const finish = (value: Uint8Array | null) => {
            if (done) return;
            done = true;
            unsubMessage();
            unsubPeer();
            options?.signal?.removeEventListener("abort", onAbort);
            resolve(value);
        };
        const onAbort = () => finish(null);
        if (options?.signal?.aborted) {
            finish(null);
            return;
        }
        options?.signal?.addEventListener("abort", onAbort);
        unsubMessage = transport.onMessage((raw) => {
            const msg = raw as WireMessage;
            if (msg && msg.t === "state" && msg.from !== tempId) {
                finish(
                    msg.u instanceof Uint8Array ? msg.u : new Uint8Array(msg.u),
                );
            }
        });
        // Peers send their state when a link opens (attachRealtimeSync's
        // onPeerConnect path); the hello below covers transports without peer
        // events and peers whose links were already open.
        unsubPeer =
            transport.onPeerConnect?.(() => {
                transport.post({ t: "hello", from: tempId } as WireMessage);
            }) ?? (() => {});
        transport.post({ t: "hello", from: tempId } as WireMessage);
    });
