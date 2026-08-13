"use client";
/**
 * Local collaboration session for AI-only use: mounted while AI
 * collaboration is enabled and NO live room is attached. Reuses the exact
 * realtime machinery over a no-op transport — a shared Y.Doc, the op-level
 * replay hot path, presence (virtual peers) and the versioning side-channel
 * (collaborator registry, authorship, version timeline, restore).
 *
 * The point: an AI agent is a REGULAR COLLABORATOR. With this session in
 * place the collaboration panel works identically with or without a live
 * room — select the agent to blame-highlight its spans, see its version
 * entries, restore past versions. No AI-special highlight channel exists.
 *
 * ONE collaboration doc per document, whatever the channel: this local
 * session and a live room session persist under the SAME per-document key,
 * so AI-first -> invite humans, humans-first -> add AI, and stop-sharing ->
 * keep editing locally are all the same data moving between channels.
 * Collaborators, authorship and version history survive reloads and
 * channel switches. On restore the SAVED DOC is the uuid/authorship origin
 * (spans keep their identities, so blame stays valid — exactly the
 * room-resume discipline), while the LIVE EDITOR CONTENT is the content
 * truth: any divergence (edits made while AI was off, external file edits)
 * is reconciled back as ordinary local edits via an md-level diff.
 */
import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { useEditorStoreApi } from "@do-md/core-react";
import { useTranslation } from "react-i18next";
import {
    attachRealtimeSync,
    type RealtimePeer,
    type RealtimeSyncHandle,
    type RealtimeTransport,
} from "@/plugins/collaboration/realtime-sync";
import {
    attachVersioning,
    type VersioningHandle,
} from "@/plugins/collaboration/versioning";
import { HOST_COLOR } from "@/features/collaboration/lib/config";
import {
    loadRoomDocBytes,
    saveRoomDocBytes,
} from "@/features/collaboration/lib/collab-store";
import { base64ToUint8 } from "@/plugins/collaboration/crdt-sync";
import { computeRangeEdits } from "@/features/editor/lib/md-diff";
import { localSelfClientId } from "../lib/storage";

const PERSIST_DEBOUNCE_MS = 500;

const noopTransport = (): RealtimeTransport => ({
    post: () => {},
    onMessage: () => () => {},
    close: () => {},
});

export interface AiSession {
    handle: RealtimeSyncHandle;
}

export interface LocalAiControl {
    /** Mark this session's data as DISCARDED: the unmount cleanup will NOT
     *  run its final persist. Callers destroying the document's
     *  collaboration data (New document, loading a different draft) must
     *  call this BEFORE deleting the stored bytes — otherwise the unmount
     *  write-back resurrects them. */
    discard(): void;
}

export function LocalAiBridge({
    docKey,
    takeInitialBytes,
    controlRef,
    onSession,
    onVersioning,
    onPeers,
}: {
    /** THE document's collaboration-data key (same key a live room session
     *  persists under — one collaboration doc per document, whatever the
     *  channel). Null -> in-memory only (e.g. unsaved desktop doc). */
    docKey: string | null;
    /** One-shot in-memory handover of the doc bytes from a session that
     *  just ended (stop-sharing keeps the collaboration data, only the
     *  network channel closes). Takes precedence over the stored bytes —
     *  avoids racing the previous session's final async persist. */
    takeInitialBytes?: () => Uint8Array | null;
    controlRef?: React.MutableRefObject<LocalAiControl | null>;
    onSession: (session: AiSession | null) => void;
    onVersioning: (handle: VersioningHandle | null) => void;
    onPeers: (peers: RealtimePeer[]) => void;
}) {
    const { t } = useTranslation();
    const store = useEditorStoreApi();
    const attachedRef = useRef(false);

    const onSessionRef = useRef(onSession);
    const onVersioningRef = useRef(onVersioning);
    const onPeersRef = useRef(onPeers);
    useEffect(() => {
        onSessionRef.current = onSession;
        onVersioningRef.current = onVersioning;
        onPeersRef.current = onPeers;
    });

    useEffect(() => {
        if (!store || attachedRef.current) return;
        attachedRef.current = true;

        let cancelled = false;
        let discarded = false;
        let handle: RealtimeSyncHandle | null = null;
        let versioning: VersioningHandle | null = null;
        let unsubPeers = () => {};
        let persistTimer: ReturnType<typeof setTimeout> | undefined;

        if (controlRef) {
            controlRef.current = {
                discard: () => {
                    discarded = true;
                },
            };
        }

        const persist = async () => {
            if (!handle || !docKey || discarded) return;
            await saveRoomDocBytes(
                docKey,
                base64ToUint8(await handle.getStateBase64()),
            );
        };
        const persistDebounced = () => {
            clearTimeout(persistTimer);
            persistTimer = setTimeout(() => void persist(), PERSIST_DEBOUNCE_MS);
        };

        void (async () => {
            const handedOver = takeInitialBytes?.() ?? null;
            const bytes =
                handedOver ??
                (docKey ? await loadRoomDocBytes(docKey) : undefined);
            if (cancelled) return;

            const clientId = localSelfClientId();
            const name = t("ai.localSelf");

            // The editor's current content is the content truth — capture it
            // BEFORE the saved doc (uuid/authorship origin) flushes over it.
            await store.flushPendingInput?.();
            const mdTruth = store.toMarkdown();

            let doc: Y.Doc | undefined;
            if (bytes && bytes.length > 0) {
                doc = new Y.Doc();
                Y.applyUpdate(doc, bytes);
            }
            handle = attachRealtimeSync(store as never, {
                room: "local-ai",
                clientId,
                name,
                color: HOST_COLOR,
                doc,
                transport: noopTransport(),
            });

            // Reconcile divergence (edits made while AI was off, external
            // file changes) back as ordinary local edits: untouched spans
            // keep their restored identities, so authorship/blame survive;
            // the delta is correctly attributed to the local user.
            if (doc) {
                const mdRestored = store.toMarkdown();
                if (mdRestored !== mdTruth) {
                    const edits = computeRangeEdits(mdRestored, mdTruth);
                    if (edits.length > 0) store.replaceRanges(...edits);
                }
            }

            versioning = attachVersioning(store as never, {
                doc: handle.doc,
                clientId,
                name,
                color: HOST_COLOR,
            });
            unsubPeers = handle.subscribePeers((peers) =>
                onPeersRef.current(peers),
            );
            onSessionRef.current({ handle });
            onVersioningRef.current(versioning);

            void persist();
            handle.doc.on("update", persistDebounced);
        })();

        return () => {
            cancelled = true;
            clearTimeout(persistTimer);
            if (controlRef) controlRef.current = null;
            onVersioningRef.current(null);
            onSessionRef.current(null);
            onPeersRef.current([]);
            unsubPeers();
            if (versioning) {
                // Flush the trailing edit burst into a final version BEFORE
                // the final persist so the stored bytes carry it.
                versioning.dispose();
            }
            if (handle) {
                handle.doc.off("update", persistDebounced);
                void persist(); // no-op when discard() was called
                handle.dispose();
            }
            attachedRef.current = false;
        };
        // Attach once per store/document; the locale-resolved display name
        // is intentionally frozen at attach time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store, docKey]);

    return null;
}
