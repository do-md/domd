"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DOMDProvider } from "@do-md/core-react";
import { useTranslation } from "react-i18next";
import { track } from "@vercel/analytics";
import { BrandMark } from "@/common/components/brand-mark";
import { tokenize } from "@/common/lib/prism";
import { appInlineRules } from "@/features/editor/lib/inline-rules";
import { beautify } from "@/common/lib/beautify";
import { isTauri } from "@/common/lib/platform";
import { tauriApp, tauriCore } from "@/common/lib/tauri";
import type { RealtimePeer } from "@/plugins/collaboration/realtime-sync";
import { RemoteCursors } from "@/plugins/collaboration/realtime-sync/remote-cursors";
import type { VersioningHandle } from "@/plugins/collaboration/versioning";
import {
    AuthorHighlights,
    type HighlightTarget,
} from "@/plugins/collaboration/versioning/author-highlights";
import {
    CollabBridge,
    ShareModal,
    VersioningPanel,
    clearDraft,
    collabImageLoader,
    deleteRoomData,
    getActiveHostRoom,
    loadDraft,
    loadRoomDocBytes,
    type CollabControl,
    type RoomRecord,
} from "@/features/collaboration";
import { NewDocModal } from "./new-doc-modal";
import { ImageDropHandler } from "../hooks/use-image-drop";
import { useDocumentLoaders } from "../hooks/use-document-loaders";
import { useTauriDragDrop } from "../hooks/use-tauri-drag-drop";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { useWebDragDrop } from "../hooks/use-web-drag-drop";
import { UpdateBanner } from "@/features/updater/update-banner";
import { Editor } from "./editor";
import { UrlModal } from "./url-modal";

export function EditorApp() {
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
    const [showVersioning, setShowVersioning] = useState(false);
    const [highlightTargets, setHighlightTargets] = useState<
        HighlightTarget[]
    >([]);
    const collabControlRef = useRef<CollabControl | null>(null);
    const collabRoomRef = useRef(collabRoom);
    collabRoomRef.current = collabRoom;

    /** Broadcast dissolution to peers (if live) and drop the room locally.
     *  The document itself stays in the editor and in the local draft. */
    const dissolveSharing = useCallback(async () => {
        const room = collabRoomRef.current;
        if (!room) return;
        collabControlRef.current?.closeRoom();
        setCollabRoom(null);
        setCollabBytes(null);
        setCollabPeers([]);
        setShowVersioning(false);
        setHighlightTargets([]);
        await deleteRoomData(room.id);
    }, []);

    /** New document: dissolve any live room, drop the draft, start blank. */
    const handleNewDoc = useCallback(async () => {
        setShowNewDocModal(false);
        await dissolveSharing();
        await clearDraft();
        applyBlank();
    }, [dissolveSharing, applyBlank]);

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
            if (hostRoom) {
                const bytes = await loadRoomDocBytes(hostRoom.id);
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
            applyBlank();
        })();
        // Run once. URL param changes come via full-remount navigation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Tauri: listen for open-file events (fired when Rust reuses this window
    // for a file double-clicked elsewhere).
    useTauriEvent<string>("open-file", (path) => {
        loadTauriPath(path);
    });

    // Tauri: menu → "Open URL..." opens the same modal as the web button.
    useTauriEvent("menu-open-url", () => setShowUrlModal(true));

    const tauriDragging = useTauriDragDrop(claimAndLoadTauriPath);
    const { dragging: webDragging, dragHandlers } = useWebDragDrop(
        ({ file, handle }) => {
            // Loading a different document dissolves the hosted room first.
            void dissolveSharing().then(() => loadFromFile(file, handle));
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
            >
                <ImageDropHandler />
                {collabRoom ? (
                    <CollabBridge
                        key={collabRoom.id}
                        room={collabRoom}
                        initialDocBytes={collabBytes}
                        controlRef={collabControlRef}
                        onPeers={setCollabPeers}
                        onVersioning={setVersioningHandle}
                        onError={(message) =>
                            console.warn("[collab] attach failed:", message)
                        }
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
                    onRequestVersioning={
                        versioningHandle
                            ? () => setShowVersioning((v) => !v)
                            : undefined
                    }
                />
                {collabRoom ? <RemoteCursors peers={collabPeers} /> : null}
                {highlightTargets.length ? (
                    <AuthorHighlights targets={highlightTargets} />
                ) : null}
            </DOMDProvider>

            {showVersioning && versioningHandle && collabRoom ? (
                <VersioningPanel
                    handle={versioningHandle}
                    selfClientId={collabRoom.clientId}
                    onlineClientIds={collabPeers.map((p) => p.clientId)}
                    topClassName="top-9"
                    onClose={() => {
                        setShowVersioning(false);
                        setHighlightTargets([]);
                    }}
                    onHighlightsChange={setHighlightTargets}
                />
            ) : null}

            {showUrlModal ? (
                <UrlModal
                    onClose={() => setShowUrlModal(false)}
                    onSubmit={(input) =>
                        // Loading a different document dissolves the room.
                        void dissolveSharing().then(() => loadRemote(input))
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
                        setCollabBytes(null);
                        setCollabRoom(room);
                    }}
                    onStop={() => void dissolveSharing()}
                />
            ) : null}

            <UpdateBanner />
        </div>
    );
}
