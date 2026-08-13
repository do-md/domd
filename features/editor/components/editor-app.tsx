"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DOMDProvider, useEditorStoreApi } from "@do-md/core-react";
import type { EditorStoreWithInserts } from "@/common/lib/editor-store-compat";
import { useTranslation } from "react-i18next";
import { track } from "@vercel/analytics";
import { BrandMark } from "@/common/components/brand-mark";
import {
    SidePanelProvider,
    useSidePanelActive,
    useSidePanelApi,
} from "@/common/components/side-panel";
import { tokenize } from "@/common/lib/prism";
import { appInlineRules } from "@/features/editor/lib/inline-rules";
import { beautify } from "@/common/lib/beautify";
import { isTauri } from "@/common/lib/platform";
import { tauriApp, tauriCore } from "@/common/lib/tauri";
import type {
    RealtimePeer,
    RealtimeSyncHandle,
} from "@/plugins/collaboration/realtime-sync";
import { RemoteCursors } from "@/plugins/collaboration/realtime-sync/remote-cursors";
import {
    AiCollab,
    AiPanel,
    LocalAiBridge,
    loadAgents,
    loadAiEnabled,
    localSelfClientId,
    saveAgents,
    saveAiEnabled,
    type AgentConfig,
    type AiSession,
    type LocalAiControl,
} from "@/features/ai";
import type { VersioningHandle } from "@/plugins/collaboration/versioning";
import {
    AuthorHighlights,
    type HighlightTarget,
} from "@/plugins/collaboration/versioning/author-highlights";
import {
    CollabBridge,
    ShareModal,
    VersioningPanel,
    clearCollabDocId,
    clearDraft,
    collabImageLoader,
    deleteRoomData,
    getActiveHostRoom,
    loadDraft,
    loadRoomDocBytes,
    setCollabDocId,
    type CollabControl,
    type RoomRecord,
} from "@/features/collaboration";
import {
    WELCOME_DOC_NAME,
    buildWelcomeMarkdown,
    hasSeenWelcome,
    markWelcomeSeen,
} from "../lib/welcome";
import { DiskReconciler, ScratchStoreBinder } from "./disk-reconciler";
import { ModeController } from "./mode-controller";
import { NewDocModal } from "./new-doc-modal";
import { ImageDropHandler } from "../hooks/use-image-drop";
import { useDocumentLoaders } from "../hooks/use-document-loaders";
import { useTauriDragDrop } from "../hooks/use-tauri-drag-drop";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { useWebDragDrop } from "../hooks/use-web-drag-drop";
import { UpdateBanner } from "@/features/updater/update-banner";
import { Editor } from "./editor";
import { UrlModal } from "./url-modal";
import { CustomRender } from "../lib/custome-render";
import { base64ToUint8 } from "@/plugins/collaboration/crdt-sync";

/**
 * ONE collaboration doc per document, whatever the channel (AI-only local
 * session or a live room): both persist their Y.Doc bytes under this
 * per-document key, so enabling sharing carries the AI history into the
 * room, and stopping sharing merely closes the network channel — the
 * collaboration data lives on.
 */
const COLLAB_DRAFT_KEY = "collab:draft";
const collabKeyForDoc = (docId: string) => `collab:${docId}`;

/**
 * Bridges the native macOS titlebar insert buttons to the editor store.
 * Rendered only on desktop, and only inside the DOMDProvider so it can reach
 * the store. Mirrors the web InsertToolbar's actions 1:1.
 */
function TitlebarInsertBridge() {
    const storeApi = useEditorStoreApi() as EditorStoreWithInserts | null;
    useTauriEvent("titlebar-insert-table", () => storeApi?.insertTable());
    useTauriEvent("titlebar-insert-checklist", () =>
        storeApi?.insertCheckList(),
    );
    return null;
}

export function EditorApp() {
    // The side-panel store provider sits ABOVE the app content so every
    // trigger surface — web top-bar buttons, the native-titlebar event
    // bridge, the drawer overlay — reaches the same store without threading
    // callbacks through props (claude-os nav-drawer pattern).
    return (
        <SidePanelProvider>
            <EditorAppContent />
        </SidePanelProvider>
    );
}

function EditorAppContent() {
    const { t } = useTranslation();
    const searchParams = useSearchParams();

    // Initial state is always null/null so SSR (`output: "export"`) and the
    // first client render produce the same neutral placeholder — no hydration
    // mismatch. The mount effect below resolves the real source.
    const {
        meta,
        setMeta,
        content,
        version,
        view,
        applyBlank,
        applyLocal,
        loadTauriPath,
        claimAndLoadTauriPath,
        loadRemote,
        loadFromFile,
    } = useDocumentLoaders();

    const [showUrlModal, setShowUrlModal] = useState(false);

    // ---- Realtime collaboration (web mode, host side) ----
    const [collabRoom, setCollabRoom] = useState<RoomRecord | null>(null);
    const [collabBytes, setCollabBytes] = useState<Uint8Array | null>(null);
    const [collabPeers, setCollabPeers] = useState<RealtimePeer[]>([]);
    const [showShareModal, setShowShareModal] = useState(false);
    const [showNewDocModal, setShowNewDocModal] = useState(false);
    const [versioningHandle, setVersioningHandle] =
        useState<VersioningHandle | null>(null);
    /** Monotonic counter, bumped when a collab session finishes attaching —
     *  the disk reconciler calibrates the shared doc against the file. */
    const [collabEpoch, setCollabEpoch] = useState(0);
    // Which side panel is open lives in the side-panel store (see
    // SidePanelProvider in EditorApp) — triggers and panels are decoupled.
    const sidePanelActive = useSidePanelActive();
    const sidePanelApi = useSidePanelApi();
    const [highlightTargets, setHighlightTargets] = useState<
        HighlightTarget[]
    >([]);
    const collabControlRef = useRef<CollabControl | null>(null);
    const collabRoomRef = useRef(collabRoom);
    collabRoomRef.current = collabRoom;

    // ---- AI collaboration (browser-local agent roster) ----
    // Agents are ordinary collaborators: they ride whatever collaboration
    // session exists. With a live room that is the room's session; without
    // one, LocalAiBridge mounts a local session (no-op transport) so the
    // collaboration panel — blame highlight, history, restore — works
    // identically. Defaults first so SSR and the first client render agree;
    // the mount effect below hydrates from localStorage (chat-app pattern).
    const [aiAgents, setAiAgents] = useState<AgentConfig[]>([]);
    const [aiEnabled, setAiEnabled] = useState(false);
    const [realtimeHandle, setRealtimeHandle] =
        useState<RealtimeSyncHandle | null>(null);
    const [localAiSession, setLocalAiSession] = useState<AiSession | null>(
        null,
    );
    useEffect(() => {
        setAiAgents(loadAgents());
        setAiEnabled(loadAiEnabled());
    }, []);
    const handleAgentsChange = useCallback((agents: AgentConfig[]) => {
        setAiAgents(agents);
        saveAgents(agents);
    }, []);
    const handleAiEnabledChange = useCallback((enabled: boolean) => {
        setAiEnabled(enabled);
        saveAiEnabled(enabled);
    }, []);
    const aiCollabSession = useMemo(
        () =>
            realtimeHandle ? { handle: realtimeHandle } : localAiSession,
        [realtimeHandle, localAiSession],
    );
    // This document's collaboration-data key (per document on desktop via
    // the frontmatter domd-id; the single draft on web). An unsaved desktop
    // window has no identity yet -> in-memory only.
    const collabDataKey =
        meta === null
            ? null
            : meta.kind === "tauri"
              ? meta.docId
                  ? collabKeyForDoc(meta.docId)
                  : null
              : COLLAB_DRAFT_KEY;
    /** One-shot channel handover: when a live room dissolves, its final doc
     *  bytes move here in memory and the local session picks them up —
     *  same collaboration data, different channel. */
    const pendingLocalBytesRef = useRef<Uint8Array | null>(null);
    const localAiControlRef = useRef<LocalAiControl | null>(null);
    /** Destroy the draft's collaboration data (New document / loading a
     *  different draft): tell the live local session to skip its unmount
     *  write-back FIRST — deleting alone gets resurrected by that final
     *  persist — then drop the stored bytes and any pending handover. */
    const discardDraftCollabData = useCallback(async () => {
        localAiControlRef.current?.discard();
        pendingLocalBytesRef.current = null;
        await deleteRoomData(COLLAB_DRAFT_KEY);
    }, []);
    const realtimeHandleRef = useRef(realtimeHandle);
    realtimeHandleRef.current = realtimeHandle;
    const localAiSessionRef = useRef(localAiSession);
    localAiSessionRef.current = localAiSession;

    /** Drop the live session state WITHOUT deleting the room record — used
     *  on desktop when another document loads into this window: the room
     *  stays in `.domd/collab.db` bound to its doc id and resumes when that
     *  file is reopened. */
    const detachSharing = useCallback(() => {
        setCollabRoom(null);
        setCollabBytes(null);
        setCollabPeers([]);
        // The versioning handle dies with the session — dismiss its panel
        // (only; an open AI panel is document-independent and survives).
        sidePanelApi.close("versioning");
        setHighlightTargets([]);
    }, [sidePanelApi]);

    /** Broadcast dissolution to peers (if live) and drop the ROOM (the
     *  network channel) locally. With `handover` (stop-sharing on the SAME
     *  document) the collaboration data lives on: the doc's final bytes
     *  move to the local session in memory, so collaborators, authorship
     *  and history continue seamlessly. Document-switch paths pass false —
     *  the next document must not inherit this one's bytes. */
    const dissolveSharing = useCallback(
        async (handover = true) => {
            const room = collabRoomRef.current;
            if (!room) return;
            collabControlRef.current?.closeRoom();
            if (handover) {
                const handle = realtimeHandleRef.current;
                const b64 = handle ? await handle.getStateBase64() : null;
                pendingLocalBytesRef.current = b64 ? base64ToUint8(b64) : null;
            } else {
                pendingLocalBytesRef.current = null;
            }
            detachSharing();
            await deleteRoomData(room.id);
        },
        [detachSharing],
    );

    /** New document: dissolve any live room, drop the draft and its
     *  collaboration data (a blank doc must not inherit the old one's
     *  collaborators/versions), start blank. */
    const handleNewDoc = useCallback(async () => {
        setShowNewDocModal(false);
        await dissolveSharing(false);
        await clearDraft();
        await discardDraftCollabData();
        applyBlank();
    }, [dissolveSharing, discardDraftCollabData, applyBlank]);

    const metaRef = useRef(meta);
    metaRef.current = meta;
    const saveRef = useRef<(() => Promise<boolean>) | null>(null);

    // Tauri-only: emit a custom analytics event on each webview mount so the
    // dashboard can distinguish desktop sessions from web pageviews. Version
    // is read via the Tauri API (canonical app version) rather than the FE
    // package.json. Failures are swallowed — analytics must not break the app.
    useEffect(() => {
        if (!isTauri()) return;
        (async () => {
            try {
                const { getVersion } = await tauriApp();
                const version = await getVersion();
                track("app_open", { platform: "tauri", version });
            } catch {
                track("app_open", { platform: "tauri" });
            }
        })();
    }, []);

    // Resolve the initial source on mount. Each branch ends by setting
    // meta/content (directly or via applyBlank), which flips view to "editor".
    useEffect(() => {
        const src = searchParams.get("src");
        const pathParam = searchParams.get("path");

        (async () => {
            if (src) {
                // Loading a different document destroys any hosted room
                // (silently — no session is attached yet to broadcast from;
                // guests notice via host absence and keep their local copy).
                if (!isTauri()) {
                    const hostRoom = await getActiveHostRoom();
                    if (hostRoom) await deleteRoomData(hostRoom.id);
                }
                await loadRemote(src);
                return;
            }
            if (pathParam && isTauri()) {
                await loadTauriPath(pathParam);
                return;
            }
            if (isTauri()) {
                const { invoke } = await tauriCore();
                const assigned = await invoke<string | null>("get_my_path");
                if (assigned) {
                    await loadTauriPath(assigned);
                    return;
                }
                applyBlank();
                return;
            }
            // Web blank doc: resume a hosted collaboration session if one is
            // active (the shared Y.Doc bytes are the source of truth), else
            // restore the local draft, else start truly blank.
            const [hostRoom, draft] = await Promise.all([
                getActiveHostRoom(),
                loadDraft(),
            ]);
            const hasDraft = draft !== null && draft.md.length > 0;
            // First open in this browser? Existing local data always wins —
            // a draft or a live session renders untouched and merely marks
            // the welcome tour as seen; only a truly blank first open gets
            // seeded with the tour document (see the fallthrough below).
            const firstVisit = !hasSeenWelcome();
            markWelcomeSeen();
            if (hostRoom) {
                // Collaboration data is keyed per DOCUMENT, not per room —
                // the same bytes the AI-only local session reads/writes.
                const bytes = await loadRoomDocBytes(COLLAB_DRAFT_KEY);
                setCollabBytes(bytes ?? null);
                setCollabRoom(hostRoom);
                // First paint from the draft (it mirrors the live doc at a
                // 600ms cadence, see useLocalDraft) instead of a blank
                // editor: the collab attach waits on a network round-trip
                // (TURN credentials) before the Y.Doc bytes flush in, and
                // that window used to flash an empty document.
                if (hasDraft) applyLocal(draft.md, draft.name);
                else applyBlank();
                return;
            }
            if (hasDraft) {
                applyLocal(draft.md, draft.name);
                return;
            }
            if (firstVisit) {
                // Seeded as an ordinary local document (the draft mirror
                // persists it), in the browser language, so a brand-new
                // user opens onto a short feature tour instead of a void.
                applyLocal(buildWelcomeMarkdown(), WELCOME_DOC_NAME);
                return;
            }
            applyBlank();
        })();
        // Run once. URL param changes come via full-remount navigation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Tauri: listen for open-file events (fired when Rust reuses this window
    // for a file double-clicked elsewhere). Detach (not dissolve) any live
    // session first — the room stays bound to its document in SQLite.
    useTauriEvent<string>("open-file", (path) => {
        detachSharing();
        loadTauriPath(path);
    });

    // Tauri: menu → "Open URL..." opens the same modal as the web button.
    useTauriEvent("menu-open-url", () => setShowUrlModal(true));

    // ---- Desktop collaboration (Tauri mode, host side) ----

    // Keep the storage backend keyed to the open document's frontmatter
    // domd-id (rooms live in the machine-global ~/.domd/collab.db — whether
    // the file is saved to disk is irrelevant). Also resume a previously
    // hosted session for this document (bytes are the shared origin — the
    // attach flushes them over the current editor content).
    const tauriDocId = meta?.kind === "tauri" ? (meta.docId ?? null) : null;
    useEffect(() => {
        if (!isTauri()) return;
        if (!tauriDocId) {
            clearCollabDocId();
            return;
        }
        setCollabDocId(tauriDocId);
        if (collabRoomRef.current) return;
        let cancelled = false;
        void (async () => {
            const room = await getActiveHostRoom();
            if (!room || cancelled) return;
            // Per-document collaboration data (shared with the local AI
            // session), not per-room.
            const bytes = await loadRoomDocBytes(collabKeyForDoc(tauriDocId));
            if (cancelled) return;
            setCollabBytes(bytes ?? null);
            setCollabRoom(room);
        })();
        return () => {
            cancelled = true;
        };
    }, [tauriDocId]);

    // Native titlebar "share" button — same modal as the web entry point.
    // Works on unsaved documents too: the doc id exists from creation.
    useTauriEvent("titlebar-share", () => setShowShareModal(true));

    // Native titlebar "manage" button — the imperative half of the
    // side-panel store (same panel the web top-bar trigger opens).
    const versioningHandleRef = useRef(versioningHandle);
    versioningHandleRef.current = versioningHandle;
    useTauriEvent("titlebar-versioning", () => {
        if (versioningHandleRef.current) sidePanelApi.toggle("versioning");
    });

    // Mirror session state to Rust so the titlebar buttons can reflect it
    // (share button tint + manage button visibility).
    useEffect(() => {
        if (!isTauri()) return;
        tauriCore().then(({ invoke }) => {
            invoke("set_collab_state", {
                active: collabRoom !== null,
                peers: collabPeers.length,
            }).catch(() => {});
        });
    }, [collabRoom, collabPeers]);

    const tauriDragging = useTauriDragDrop((path) => {
        detachSharing();
        void claimAndLoadTauriPath(path);
    });
    const { dragging: webDragging, dragHandlers } = useWebDragDrop(
        ({ file, handle }) => {
            // Loading a different document dissolves the hosted room and
            // destroys the draft's collaboration data — the new document
            // must not inherit collaborators/history.
            void dissolveSharing(false)
                .then(() => discardDraftCollabData())
                .then(() => loadFromFile(file, handle));
        },
    );

    const isWeb = !isTauri();
    const dragging = tauriDragging || webDragging;

    if (view === "loading" || meta === null || content === null) {
        // Loading covers ONLY the content area: the top bar (same classes as
        // the real one in Editor) paints immediately so the page never reads
        // as a slow full-screen blank. Desktop has no web top bar — the
        // native window chrome is already visible, keep the plain surface.
        if (!isWeb) {
            return <div className="fixed inset-0 bg-base-100" />;
        }
        return (
            <div className="fixed inset-0 flex flex-col bg-base-100">
                <div className="shrink-0 h-9 flex items-center gap-1.5 px-3 text-xs text-base-content/50 bg-base-200 border-b border-base-300 select-none">
                    <BrandMark />
                </div>
                <div className="flex-1 min-h-0 flex items-center justify-center">
                    <span className="loading loading-dots loading-md text-base-content/40" />
                </div>
            </div>
        );
    }

    // Resolve the store's active panel kind to actual content (mutual
    // exclusivity is inherent — the store holds one slot). Rendered into
    // the Editor's SidePanelHost: an in-flow sibling of the document on
    // large screens (the document shrinks), a DaisyUI overlay drawer below
    // lg. Closed = null = unmounted (the versioning panel clears its
    // highlights in its own unmount cleanup).
    const sidePanel =
        sidePanelActive === "ai" ? (
            <AiPanel
                agents={aiAgents}
                onAgentsChange={handleAgentsChange}
                enabled={aiEnabled}
                onEnabledChange={handleAiEnabledChange}
                onClose={() => sidePanelApi.close("ai")}
            />
        ) : sidePanelActive === "versioning" && versioningHandle ? (
            <VersioningPanel
                handle={versioningHandle}
                selfClientId={
                    collabRoom ? collabRoom.clientId : localSelfClientId()
                }
                onlineClientIds={collabPeers.map((p) => p.clientId)}
                onClose={() => sidePanelApi.close("versioning")}
                onHighlightsChange={setHighlightTargets}
            />
        ) : null;

    return (
        <div
            onDragOver={isWeb ? dragHandlers.onDragOver : undefined}
            onDragLeave={isWeb ? dragHandlers.onDragLeave : undefined}
            onDrop={isWeb ? dragHandlers.onDrop : undefined}
        >
            {dragging ? (
                <div className="fixed inset-0 z-20 flex items-center justify-center bg-accent/90 pointer-events-none">
                    <div className="text-lg font-medium text-accent-content">
                        {t("editor.releaseToOpen")}
                    </div>
                </div>
            ) : null}

            <DOMDProvider
                key={version}
                editable={true}
                placeholder={t("editor.placeholder")}
                initMd={content}
                imageLoader={collabImageLoader}
                codeTokenizer={tokenize}
                inlineRules={appInlineRules}
                codeBeautify={beautify}
                renderComponent={CustomRender}
                mode="rich"
            >
                <ImageDropHandler />
                {/* Hydrates the persisted display mode + binds Cmd+/ —
                    the "more" menu entry (web) and this keystroke (both
                    runtimes) call the same toggle. */}
                <ModeController />
                {/* Desktop has no web top bar; the native titlebar's
                    table/checklist buttons emit these events (see
                    src-tauri/src/titlebar.rs). This bridge lives inside the
                    provider so it can reach the editor store. */}
                {!isWeb ? <TitlebarInsertBridge /> : null}
                {collabRoom ? (
                    <CollabBridge
                        key={collabRoom.id}
                        room={collabRoom}
                        initialDocBytes={collabBytes}
                        dataKey={collabDataKey ?? undefined}
                        controlRef={collabControlRef}
                        onPeers={setCollabPeers}
                        onVersioning={setVersioningHandle}
                        onHandle={setRealtimeHandle}
                        onAttached={() => setCollabEpoch((n) => n + 1)}
                        onError={(message) =>
                            console.warn("[collab] attach failed:", message)
                        }
                    />
                ) : null}
                {!isWeb ? (
                    <DiskReconciler
                        meta={meta}
                        onMetaUpdate={setMeta}
                        collabEpoch={collabEpoch}
                    />
                ) : null}
                <Editor
                    meta={meta}
                    onMetaUpdate={setMeta}
                    onRequestOpenUrl={() => setShowUrlModal(true)}
                    saveRef={saveRef}
                    collabActive={collabRoom !== null}
                    collabPeerCount={collabPeers.length}
                    onRequestShare={
                        isWeb ? () => setShowShareModal(true) : undefined
                    }
                    onRequestNew={
                        isWeb ? () => setShowNewDocModal(true) : undefined
                    }
                    versioningAvailable={versioningHandle !== null}
                    aiAvailable={isWeb}
                    aiActive={aiEnabled && aiAgents.length > 0}
                    sidePanel={sidePanel}
                />
                {/* Local collaboration session while AI is on without a
                    live room: same doc/versioning machinery over a no-op
                    transport, so the collaboration panel treats agents as
                    ordinary collaborators (blame, history, restore). */}
                {aiEnabled && !collabRoom ? (
                    <LocalAiBridge
                        key={collabDataKey ?? "memory"}
                        docKey={collabDataKey}
                        takeInitialBytes={() => {
                            const bytes = pendingLocalBytesRef.current;
                            pendingLocalBytesRef.current = null;
                            return bytes;
                        }}
                        controlRef={localAiControlRef}
                        onSession={setLocalAiSession}
                        onVersioning={setVersioningHandle}
                        onPeers={setCollabPeers}
                    />
                ) : null}
                <AiCollab
                    agents={aiAgents}
                    enabled={aiEnabled}
                    session={aiCollabSession}
                />
                {collabPeers.length > 0 ? (
                    <RemoteCursors peers={collabPeers} />
                ) : null}
                {highlightTargets.length ? (
                    <AuthorHighlights targets={highlightTargets} />
                ) : null}
            </DOMDProvider>

            {/* Hidden scratch provider (store only — no <DOMD/> surface, so
                no editor DOM): canonicalizes external markdown for the disk
                reconciler with the same parsing options as the live editor. */}
            {!isWeb ? (
                <DOMDProvider
                    editable={false}
                    initMd=""
                    placeholder=""
                    codeTokenizer={tokenize}
                    inlineRules={appInlineRules}
                    codeBeautify={beautify}
                >
                    <ScratchStoreBinder />
                </DOMDProvider>
            ) : null}

            {showUrlModal ? (
                <UrlModal
                    onClose={() => setShowUrlModal(false)}
                    onSubmit={(input) =>
                        // Loading a different document dissolves the room
                        // and destroys the draft's collaboration data.
                        void dissolveSharing(false)
                            .then(() => discardDraftCollabData())
                            .then(() => loadRemote(input))
                    }
                />
            ) : null}

            {showNewDocModal ? (
                <NewDocModal
                    collabActive={collabRoom !== null}
                    onClose={() => setShowNewDocModal(false)}
                    onConfirm={() => void handleNewDoc()}
                />
            ) : null}

            {showShareModal ? (
                <ShareModal
                    room={collabRoom}
                    onClose={() => setShowShareModal(false)}
                    onCreated={(room) => {
                        void (async () => {
                            // Same collaboration data, new channel: the local
                            // AI session's doc (collaborators, authorship,
                            // history included) becomes the room's origin doc.
                            const handle = localAiSessionRef.current?.handle;
                            const b64 = handle
                                ? await handle.getStateBase64()
                                : null;
                            setCollabBytes(b64 ? base64ToUint8(b64) : null);
                            setCollabRoom(room);
                        })();
                    }}
                    onStop={() => void dissolveSharing()}
                />
            ) : null}

            <UpdateBanner />
        </div>
    );
}
