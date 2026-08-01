"use client";
/**
 * Mounts inside a DOMDProvider and wires the editor store to a WebRTC
 * realtime session (host and guest alike):
 *
 *   store <-> attachRealtimeSync <-> createWebRtcTransport <-> peers
 *
 * Shared-origin discipline: pass `initialDocBytes` whenever this browser has
 * ever seen the room doc (host restore, guest rejoin, guest first join after
 * fetchInitialState). Only a host CREATING a room may attach without bytes —
 * that instance becomes the origin and persists immediately.
 *
 * Persistence: every doc update (local or remote) is debounced into
 * IndexedDB, so any participant can go offline and later re-merge from its
 * own bytes.
 */
import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { useEditorStoreApi } from "@do-md/core-react";
import {
    hasWebImage,
    readWebImageBytes,
    storeWebImageBytes,
} from "@/common/lib/image-storage";
import {
    attachCrdtSync,
    base64ToUint8,
} from "@/plugins/collaboration/crdt-sync";
import {
    attachRealtimeSync,
    type RealtimePeer,
    type RealtimeSyncHandle,
} from "@/plugins/collaboration/realtime-sync";
import {
    attachBlobSync,
    type BlobSyncHandle,
} from "@/plugins/collaboration/realtime-sync/blob-sync";
import {
    createWebRtcTransport,
    type WebRtcTransportStatus,
} from "@/plugins/collaboration/realtime-sync/webrtc-transport";
import {
    attachVersioning,
    type VersioningHandle,
} from "@/plugins/collaboration/versioning";
import { getIceServers, getSignalingUrl } from "../lib/config";
import { saveRoomDocBytes } from "../lib/collab-store";
import {
    markCollabBlobFetcherExpected,
    setCollabBlobFetcher,
} from "../lib/collab-image-loader";
import type { RoomRecord } from "../lib/types";

const PERSIST_DEBOUNCE_MS = 500;

export interface CollabControl {
    /** Broadcast room dissolution to every connected peer (host action). */
    closeRoom(): void;
}

export function CollabBridge({
    room,
    initialDocBytes,
    controlRef,
    onPeers,
    onStatus,
    onRoomClosed,
    onError,
    onVersioning,
    onAttached,
}: {
    room: RoomRecord;
    initialDocBytes: Uint8Array | null;
    controlRef?: React.MutableRefObject<CollabControl | null>;
    onPeers?: (peers: RealtimePeer[]) => void;
    onStatus?: (status: WebRtcTransportStatus) => void;
    onRoomClosed?: (from: string) => void;
    onError?: (message: string) => void;
    /** Receives the versioning handle once the session attaches (null again
     *  on teardown). Drives the version-history panel. */
    onVersioning?: (handle: VersioningHandle | null) => void;
    /** Fires once the realtime session is attached and the shared doc has
     *  been flushed into the store (desktop uses it to calibrate against
     *  the disk file). */
    onAttached?: () => void;
}) {
    const store = useEditorStoreApi();
    const attachedRef = useRef(false);

    // Synchronous render-time mark (idempotent): image components rendering
    // BEFORE the async attach completes must wait for the blob fetcher
    // instead of failing permanently. The bridge renders ahead of the editor
    // surface in both host and guest trees.
    markCollabBlobFetcherExpected();

    // Callbacks via refs so the attach effect never re-runs on new closures.
    const onPeersRef = useRef(onPeers);
    onPeersRef.current = onPeers;
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    const onRoomClosedRef = useRef(onRoomClosed);
    onRoomClosedRef.current = onRoomClosed;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const onVersioningRef = useRef(onVersioning);
    onVersioningRef.current = onVersioning;
    const onAttachedRef = useRef(onAttached);
    onAttachedRef.current = onAttached;

    useEffect(() => {
        if (!store || attachedRef.current) return;
        attachedRef.current = true;

        let cancelled = false;
        let transport: ReturnType<typeof createWebRtcTransport> | null = null;
        let handle: RealtimeSyncHandle | null = null;
        let versioning: VersioningHandle | null = null;
        let blobSync: BlobSyncHandle | null = null;
        let persistTimer: ReturnType<typeof setTimeout> | undefined;
        let unsubPeers = () => {};

        const persist = () => {
            if (!handle) return;
            const bytes = base64ToUint8(handle.getStateBase64());
            void saveRoomDocBytes(room.id, bytes);
        };
        const persistDebounced = () => {
            clearTimeout(persistTimer);
            persistTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
        };

        void (async () => {
            // TURN credentials come from the signaling worker; STUN-only on
            // failure. Must resolve before the transport exists.
            const iceServers = await getIceServers();
            if (cancelled) return;

            transport = createWebRtcTransport({
                signalingUrl: getSignalingUrl(),
                roomId: room.id,
                clientId: room.clientId,
                key: room.key,
                exp: room.exp,
                iceServers,
                onStatusChange: (status) => onStatusRef.current?.(status),
            });

            try {
                let doc: Y.Doc | undefined;
                if (initialDocBytes) {
                    doc = new Y.Doc();
                    Y.applyUpdate(doc, initialDocBytes);
                }
                handle = attachRealtimeSync(store as never, {
                    room: room.id,
                    clientId: room.clientId,
                    name: room.displayName,
                    color: room.color,
                    doc,
                    transport,
                    onRoomClosed: (from) => onRoomClosedRef.current?.(from),
                    // Viewers receive doc + presence but emit neither edits
                    // nor presence (they stay out of every peer list).
                    readonly: room.role === "viewer",
                });
                // Anchor the origin bytes right away (critical on host
                // creation: these are the item identities guests clone).
                persist();
                handle.doc.on("update", persistDebounced);
                unsubPeers = handle.subscribePeers(
                    (peers) => onPeersRef.current?.(peers),
                );
                // Versioning side-channel (authorship + collaborator
                // registry + version timeline) rides the same doc, so it
                // syncs and persists through the existing pipeline. Viewers
                // observe without leaving any trace.
                versioning = attachVersioning(store as never, {
                    doc: handle.doc,
                    clientId: room.clientId,
                    name: room.displayName,
                    color: room.color,
                    observeOnly: room.role === "viewer",
                });
                onVersioningRef.current?.(versioning);
                // Image blob exchange over the dedicated per-peer blob
                // channel: serve local blobs and pull missing ones on demand
                // (see collab-image-loader).
                blobSync = attachBlobSync(transport, {
                    has: hasWebImage,
                    get: readWebImageBytes,
                });
                const blobHandle = blobSync;
                setCollabBlobFetcher(async (id) => {
                    const result = await blobHandle.fetch(id);
                    if (!result) return false;
                    return storeWebImageBytes(
                        id,
                        result.bytes,
                        result.mimeType,
                    );
                });
                if (controlRef) {
                    controlRef.current = {
                        closeRoom: () => handle?.closeRoom(),
                    };
                }
                onAttachedRef.current?.();
            } catch (e) {
                transport.close();
                transport = null;
                onErrorRef.current?.(
                    e instanceof Error ? e.message : String(e),
                );
            }
        })();

        return () => {
            cancelled = true;
            clearTimeout(persistTimer);
            if (controlRef) controlRef.current = null;
            setCollabBlobFetcher(null);
            blobSync?.dispose();
            if (versioning) {
                onVersioningRef.current?.(null);
                // Flushes the trailing edit burst into a final version —
                // must precede the persist below so the bytes carry it.
                versioning.dispose();
            }
            if (handle) {
                handle.doc.off("update", persistDebounced);
                // The versioning flush above may have re-armed the debounce
                // timer via the doc update; the synchronous persist below
                // supersedes it.
                clearTimeout(persistTimer);
                persist();
                unsubPeers();
                handle.dispose(); // also closes the transport
            } else {
                transport?.close();
            }
            attachedRef.current = false;
        };
        // Attach once per mounted room session; identity changes remount via key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store]);

    return null;
}

/**
 * Local-only bridge for a CLOSED room: no transport, no presence — just a
 * store <-> Y.Doc mirror plus debounced IndexedDB persistence, so the
 * "keep editing your local copy" promise survives page reloads.
 *
 * - `initialDocBytes` set (reopening the invite link after the host
 *   dissolved the room): the persisted doc is the source of truth and
 *   hydrates the empty editor.
 * - `initialDocBytes` null (the room dissolved mid-session): the live editor
 *   content seeds a fresh doc. New Yjs item identities are fine here — a
 *   closed room never merges with another peer again.
 */
export function LocalCollabBridge({
    roomId,
    initialDocBytes,
}: {
    roomId: string;
    initialDocBytes: Uint8Array | null;
}) {
    const store = useEditorStoreApi();
    const attachedRef = useRef(false);

    useEffect(() => {
        if (!store || attachedRef.current) return;
        attachedRef.current = true;

        let doc: Y.Doc | undefined;
        if (initialDocBytes) {
            doc = new Y.Doc();
            Y.applyUpdate(doc, initialDocBytes);
        }
        const handle = attachCrdtSync(store as never, { doc });

        let persistTimer: ReturnType<typeof setTimeout> | undefined;
        const persist = () => {
            void saveRoomDocBytes(
                roomId,
                base64ToUint8(handle.getStateBase64()),
            );
        };
        const persistDebounced = () => {
            clearTimeout(persistTimer);
            persistTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
        };
        persist();
        handle.doc.on("update", persistDebounced);

        return () => {
            clearTimeout(persistTimer);
            handle.doc.off("update", persistDebounced);
            persist();
            handle.dispose();
            attachedRef.current = false;
        };
        // Attach once per mount; the closed-room identity never changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store]);

    return null;
}
