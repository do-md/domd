"use client";
/**
 * Guest-side page for an invite link (/collab?id=..&exp=..&kc=..#k=..).
 *
 * Join flow: parse invite -> (rejoin shortcut if this browser already holds
 * the room) -> name/password form -> derive key + verify the key-check ->
 * fetch the origin doc bytes from ANY online peer (host not required) ->
 * mount the editor with CollabBridge. The doc is persisted locally so the
 * guest can edit offline and re-merge on reconnect.
 *
 * Dead rooms (dissolved by the host, or past their link lifetime) stay
 * useful: while a session is live, a "close" broadcast flips it into
 * local-only mode (banner + LocalCollabBridge, no network); reopening the
 * invite link later restores the same local-only editor from the persisted
 * bytes instead of a dead "room closed"/"expired" card. For an existing
 * session the exp recorded at join governs, not the URL's copy. Only a
 * browser that never held the doc gets the dead-end card.
 *
 * Read-only links (`v=1`) skip the name prompt entirely: passwordless viewer
 * links auto-join with no form at all; password-gated ones ask only for the
 * password. Viewers render a non-editable surface, emit no edits/presence
 * (see attachRealtimeSync readonly), and still receive doc + cursor pushes —
 * including full-state re-merge after coming back online (peers push state
 * on every peer-link open). Opening the EDIT link in a browser that joined
 * as viewer upgrades it through the regular join form.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import {
    DOMD,
    DOMDProvider,
    deserializeRenderData,
    toMarkdown,
    useEditor,
    useEditorStore,
    useEditorStoreApi,
    useRenderData,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { BrandMark } from "@/common/components/brand-mark";
import { FormatDropdown } from "@/common/components/format-dropdown";
import { FormatShortcuts } from "@/common/components/format-shortcuts";
import { InsertToolbar } from "@/common/components/insert-toolbar";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";
import {
    SidePanelHost,
    SidePanelProvider,
    SidePanelTrigger,
    useSidePanelActive,
    useSidePanelApi,
} from "@/common/components/side-panel";
import { tokenize } from "@/common/lib/prism";
import { appInlineRules } from "@/features/editor/lib/inline-rules";
import { beautify } from "@/common/lib/beautify";
// Direct module imports (not the features/editor barrel) to avoid a cycle:
// editor's barrel imports from features/collaboration.
import { ImageDropHandler } from "@/features/editor/hooks/use-image-drop";
import { ModeController } from "@/features/editor/components/mode-controller";
import {
    MODE_TOGGLE_SHORTCUT,
    toggleEditorMode,
} from "@/features/editor/lib/editor-mode";
import { exportToPdf } from "@/features/editor/lib/export-pdf";
import { saveDocument } from "@/features/editor/lib/save-document";
import type { FileMeta } from "@/features/editor/lib/types";
import {
    fetchInitialState,
    type RealtimePeer,
} from "@/plugins/collaboration/realtime-sync";
import { RemoteCursors } from "@/plugins/collaboration/realtime-sync/remote-cursors";
import {
    createWebRtcTransport,
    type WebRtcTransportStatus,
} from "@/plugins/collaboration/realtime-sync/webrtc-transport";
import type { VersioningHandle } from "@/plugins/collaboration/versioning";
import {
    AuthorHighlights,
    type HighlightTarget,
} from "@/plugins/collaboration/versioning/author-highlights";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";
import { QuickInputBar } from "@/plugins/toolbar/quick-input-bar";
import {
    useVisualViewportPin,
    type ViewportPin,
} from "@/plugins/shared/use-visual-viewport-pin";
import {
    getIceServers,
    getSignalingUrl,
    pickGuestColor,
} from "../lib/config";
import { collabImageLoader } from "../lib/collab-image-loader";
import {
    deactivateRoom,
    getRoom,
    loadRoomDocBytes,
    putRoom,
    saveRoomDocBytes,
} from "../lib/collab-db";
import {
    deriveKeyCheck,
    deriveRoomKey,
    generateClientId,
} from "../lib/crypto";
import {
    ROOT_KEY,
    yNodeToJSON,
} from "@/plugins/collaboration/crdt-sync/y-mapping";
import { isInviteExpired, parseInvite, type InviteParams } from "../lib/invite";
import type { RoomRecord } from "../lib/types";
import { CollabBridge, LocalCollabBridge } from "./collab-bridge";
import { HistoryIcon, VersioningPanel } from "./versioning-panel";
import { CustomRender } from "@/features/editor/lib/custome-render";

type Phase =
    | { kind: "loading" }
    | { kind: "invalid" }
    | { kind: "expired" }
    | { kind: "closed" }
    | { kind: "host" } // this browser hosts the room — joining would clobber it
    | { kind: "form" }
    | { kind: "fetching"; room: RoomRecord }
    | { kind: "live"; room: RoomRecord; bytes: Uint8Array };

function EllipsisVerticalIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className={className}
            aria-hidden="true"
        >
            <circle cx="12" cy="5" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
        </svg>
    );
}

/** How long the "Downloaded" confirmation label lingers on the menu entry. */
const SAVED_LABEL_MS = 2000;

/**
 * The "more" (⋯) menu, mirroring the host editor's entries that apply to a
 * collaboration room: display-mode toggle, Download, Export PDF. "Open URL"
 * is deliberately absent — a room has no document-loading path; the shared
 * doc IS the document. Must render inside the DOMDProvider (store hooks).
 */
function CollabMoreMenu({
    contentRef,
}: {
    contentRef: React.RefObject<HTMLDivElement | null>;
}) {
    const { t } = useTranslation();
    const store = useEditorStoreApi();
    const mode = useEditorStore((s) => s.mode);
    const renderData = useRenderData();
    const mac = useApplePlatform();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Web save target for "Download": starts handle-less (picker / anchor
    // download), then keeps the handle a save minted so repeat downloads
    // overwrite the same file — the host editor's web-save behavior.
    const webMetaRef = useRef<Extract<FileMeta, { kind: "web" }>>({
        kind: "web",
        name: "Untitled.md",
        handle: null,
    });
    useEffect(
        () => () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        },
        [],
    );

    const getTitle = useCallback(() => store?.getTitle() ?? "", [store]);

    const handleDownload = useCallback(async () => {
        if (saving) return;
        setSaving(true);
        try {
            const md = toMarkdown(renderData) ?? "";
            const result = await saveDocument(webMetaRef.current, md, getTitle);
            if (result.ok && result.meta.kind === "web") {
                webMetaRef.current = result.meta;
                setSaved(true);
                if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
                savedTimerRef.current = setTimeout(() => {
                    setSaved(false);
                    savedTimerRef.current = null;
                }, SAVED_LABEL_MS);
            }
        } finally {
            setSaving(false);
        }
    }, [saving, renderData, getTitle]);

    return (
        <div className="dropdown dropdown-end">
            <div
                tabIndex={0}
                role="button"
                className="btn btn-xs btn-ghost btn-square text-base-content/60"
                aria-label={t("editor.more")}
            >
                <EllipsisVerticalIcon className="size-4" />
            </div>
            <ul
                tabIndex={0}
                className="dropdown-content menu menu-sm mt-1 w-52 rounded-box border border-base-content/15 bg-base-100 p-1 shadow-md"
            >
                {/* Display-mode switch — same fixed-label + toggle control as
                    the host editor, same toggleEditorMode call as Cmd+/. The
                    menu stays open so the change is visible behind it. */}
                <li>
                    <label className="flex items-center gap-2">
                        <span className="flex-1">
                            {t("editor.modeMarkdown")}
                        </span>
                        <span className="text-[10px] leading-none text-base-content/35 tabular-nums">
                            {mac
                                ? MODE_TOGGLE_SHORTCUT.mac
                                : MODE_TOGGLE_SHORTCUT.other}
                        </span>
                        <input
                            type="checkbox"
                            className="toggle toggle-xs"
                            checked={mode === "markdown"}
                            onChange={() => {
                                if (store) toggleEditorMode(store, mode);
                            }}
                        />
                    </label>
                </li>
                <li>
                    <button
                        disabled={saving}
                        onClick={(e) => {
                            e.currentTarget.blur();
                            void handleDownload();
                        }}
                    >
                        {saving
                            ? t("editor.downloading")
                            : saved
                              ? t("editor.downloaded")
                              : t("editor.download")}
                    </button>
                </li>
                <li>
                    <button
                        onClick={(e) => {
                            e.currentTarget.blur();
                            exportToPdf(
                                contentRef.current,
                                getTitle() || "Untitled",
                            );
                        }}
                    >
                        {t("editor.exportPdf")}
                    </button>
                </li>
            </ul>
        </div>
    );
}

function GuestEditorSurface({
    keyboardPin,
    contentRef,
}: {
    keyboardPin: ViewportPin | null;
    /** Owned by the parent so the "more" menu can export the rendered DOM. */
    contentRef: React.RefObject<HTMLDivElement | null>;
}) {
    const editor = useEditor();
    const isEditable = useEditorStore((store) => store.isEditable);
    const renderData = useRenderData();
    const scrollAreaRef = useRef<HTMLDivElement>(null);

    // Same debugging affordance the host editor exposes (window.toMarkdown).
    useEffect(() => {
        (window as Window & { toMarkdown?: () => string }).toMarkdown = () =>
            toMarkdown(renderData) ?? "";
    }, [renderData]);

    // Software keyboard shrinks the content area — scroll the caret back
    // into the visible region (same approach as the host editor: scroll the
    // INTERNAL container only; panning the layout viewport on iOS drifts).
    useEffect(() => {
        if (!keyboardPin) return;
        const container = scrollAreaRef.current;
        if (!container) return;
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        if (!container.contains(sel.anchorNode)) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const box = container.getBoundingClientRect();
        if (rect.bottom > box.bottom - 8) {
            container.scrollBy({ top: rect.bottom - (box.bottom - 8) + 24 });
        } else if (rect.top < box.top + 8) {
            container.scrollBy({ top: rect.top - (box.top + 8) - 24 });
        }
    }, [keyboardPin]);

    return (
        <div
            ref={scrollAreaRef}
            className="flex-1 min-h-0 overflow-y-auto"
            onClick={(e) => {
                if (contentRef.current?.contains(e.target as Node)) return;
                editor?.focus();
            }}
        >
            <div className="max-w-3xl mx-auto px-6 py-8">
                <div ref={contentRef}>
                    <DOMD />
                    {isEditable && <CustomCursor />}
                </div>
            </div>
        </div>
    );
}

/**
 * Derive the room key, verify the key-check and persist the RoomRecord.
 * Returns null on a key-check mismatch (wrong password / corrupted link).
 * Viewers get a fixed display name — it is never broadcast anywhere.
 */
async function joinRoom(
    invite: InviteParams,
    secret: string,
    name: string,
): Promise<RoomRecord | null> {
    const keyCheck = await deriveKeyCheck(secret, invite.roomId, invite.exp);
    if (invite.keyCheck && keyCheck !== invite.keyCheck) return null;
    const key = await deriveRoomKey(secret, invite.roomId, invite.exp);
    const clientId = generateClientId();
    const now = Date.now();
    const room: RoomRecord = {
        id: invite.roomId,
        role: invite.readonly ? "viewer" : "guest",
        clientId,
        displayName: invite.readonly
            ? "Viewer"
            : name || `Guest-${clientId.slice(0, 4)}`,
        color: pickGuestColor(clientId),
        exp: invite.exp,
        linkSecret: invite.linkSecret,
        keyCheck,
        key,
        active: 1,
        createdAt: now,
        updatedAt: now,
    };
    await putRoom(room);
    return room;
}

/**
 * Fullscreen column with the same top bar as the live surface: every
 * pre-live phase (loading, join form, doc fetch, dead-room cards) paints
 * the bar immediately and confines its own state to the content area —
 * a full-screen overlay would read as a slow, blank page.
 */
function CollabShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 flex flex-col bg-base-100 text-base-content">
            <header className="shrink-0 h-10 flex items-center px-3 bg-base-200 border-b border-base-300 select-none">
                <BrandMark />
            </header>
            <div className="flex-1 min-h-0 flex items-center justify-center p-4">
                {children}
            </div>
        </div>
    );
}

function CenterCard({ children }: { children: React.ReactNode }) {
    return (
        <CollabShell>
            <div className="w-[24rem] max-w-full rounded-xl border border-base-content/10 bg-base-100 shadow-sm p-6">
                {children}
            </div>
        </CollabShell>
    );
}

export function CollabApp() {
    // Side-panel store provider above the content: the header trigger and
    // the panel host share state through the store, not through props
    // (claude-os nav-drawer pattern — same wiring as the host editor).
    return (
        <SidePanelProvider>
            <CollabAppContent />
        </SidePanelProvider>
    );
}

function CollabAppContent() {
    const { t } = useTranslation();
    const searchParams = useSearchParams();
    // Software-keyboard geometry (mobile) — same dual-layer pinning as the
    // host editor so the quick-input bar rides the keyboard's top edge.
    const keyboardPin = useVisualViewportPin();

    const [invite, setInvite] = useState<InviteParams | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: "loading" });
    const [formName, setFormName] = useState("");
    const [formPassword, setFormPassword] = useState("");
    const [formError, setFormError] = useState<string | null>(null);
    const [joining, setJoining] = useState(false);
    const [peers, setPeers] = useState<RealtimePeer[]>([]);
    const [status, setStatus] = useState<WebRtcTransportStatus | null>(null);
    const [versioningHandle, setVersioningHandle] =
        useState<VersioningHandle | null>(null);
    // Panel open-state lives in the side-panel store (provider above).
    const versioningOpen = useSidePanelActive() === "versioning";
    const sidePanelApi = useSidePanelApi();
    const [highlightTargets, setHighlightTargets] = useState<
        HighlightTarget[]
    >([]);
    // Rendered-document root, owned here so the header's "more" menu can
    // export it to PDF while the surface component keeps using it for
    // click-to-focus hit-testing.
    const contentRef = useRef<HTMLDivElement>(null);
    // null = room open. Otherwise the room is dead ("dissolved" by the host
    // or "expired" past its link lifetime — the banner wording differs) and
    // `restored` says how the editor got its content: false = it went dead
    // mid-session (the editor already holds the content), true = the link
    // was reopened afterwards, so the editor hydrates from the persisted
    // local copy.
    const [closedState, setClosedState] = useState<{
        reason: "dissolved" | "expired";
        restored: boolean;
    } | null>(null);
    const roomClosed = closedState !== null;

    // Resolve the invite + any prior local session once on mount.
    useEffect(() => {
        const parsed = parseInvite(
            searchParams,
            typeof window !== "undefined" ? window.location.hash : "",
        );
        if (!parsed) {
            setPhase({ kind: "invalid" });
            return;
        }
        setInvite(parsed);
        (async () => {
            const existing = await getRoom(parsed.roomId);
            if (existing?.role === "host") {
                setPhase({ kind: "host" });
                return;
            }
            if (existing) {
                // A dead room (dissolved by the host, or past the lifetime
                // recorded at join — the stored exp governs an existing
                // session; the URL's copy only matters for fresh joins) may
                // still have a local copy in this browser. Keep the "you can
                // still edit your local copy" promise across reloads instead
                // of a dead end.
                const dissolved = existing.active === 0;
                const expired = isInviteExpired(existing.exp);
                if (dissolved || expired) {
                    const bytes = await loadRoomDocBytes(parsed.roomId);
                    if (bytes) {
                        setClosedState({
                            reason: dissolved ? "dissolved" : "expired",
                            restored: true,
                        });
                        setPhase({ kind: "live", room: existing, bytes });
                    } else {
                        setPhase({
                            kind: dissolved ? "closed" : "expired",
                        });
                    }
                    return;
                }
                // Rejoin shortcut — except a viewer opening the EDIT link,
                // which upgrades through the regular join form (the edit
                // link itself is the capability; a fresh guest identity
                // replaces the viewer one).
                if (!(existing.role === "viewer" && !parsed.readonly)) {
                    const bytes = await loadRoomDocBytes(parsed.roomId);
                    if (bytes) {
                        setPhase({ kind: "live", room: existing, bytes });
                    } else {
                        setPhase({ kind: "fetching", room: existing });
                    }
                    return;
                }
            }
            // Fresh join (or viewer->editor upgrade): the URL's exp is the
            // only lifetime we have.
            if (isInviteExpired(parsed.exp)) {
                setPhase({ kind: "expired" });
                return;
            }
            // Passwordless read-only link: nothing to ask — join silently.
            if (parsed.readonly && parsed.linkSecret) {
                const room = await joinRoom(parsed, parsed.linkSecret, "");
                if (room) setPhase({ kind: "fetching", room });
                else setPhase({ kind: "invalid" });
                return;
            }
            setPhase({ kind: "form" });
        })();
        // Invite params come from the initial URL; changes navigate fully.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // First-join doc fetch: any online peer that holds the doc can serve it
    // (the host does NOT need to be online — a fellow guest works too).
    useEffect(() => {
        if (phase.kind !== "fetching") return;
        const { room } = phase;
        const controller = new AbortController();
        let transport: ReturnType<typeof createWebRtcTransport> | null = null;
        void (async () => {
            const iceServers = await getIceServers();
            if (controller.signal.aborted) return;
            // Temporary identity for the bootstrap connection; the durable
            // clientId is used once the editor session attaches. The SAME id
            // must go to both the transport and fetchInitialState — peers
            // answer "hello" via postTo(msg.from), which routes by the
            // transport-level peer id.
            const bootstrapId = generateClientId();
            transport = createWebRtcTransport({
                signalingUrl: getSignalingUrl(),
                roomId: room.id,
                clientId: bootstrapId,
                key: room.key,
                exp: room.exp,
                iceServers,
                onStatusChange: setStatus,
            });
            const bytes = await fetchInitialState(transport, {
                signal: controller.signal,
                clientId: bootstrapId,
            });
            transport.close();
            if (!bytes || controller.signal.aborted) return;
            await saveRoomDocBytes(room.id, bytes);
            setPhase({ kind: "live", room, bytes });
        })();
        return () => {
            controller.abort();
            transport?.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase.kind]);

    const handleJoin = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            if (!invite || joining) return;
            const secret = invite.linkSecret ?? formPassword.trim();
            if (!secret) {
                setFormError(t("collab.join.passwordRequired"));
                return;
            }
            setJoining(true);
            setFormError(null);
            try {
                const room = await joinRoom(invite, secret, formName.trim());
                if (!room) {
                    setFormError(t("collab.join.wrongPassword"));
                    return;
                }
                // A viewer->editor upgrade already holds the doc bytes
                // locally — skip the peer fetch and go live immediately.
                const bytes = await loadRoomDocBytes(invite.roomId);
                if (bytes) {
                    setPhase({ kind: "live", room, bytes });
                } else {
                    setPhase({ kind: "fetching", room });
                }
            } finally {
                setJoining(false);
            }
        },
        [invite, joining, formName, formPassword, t],
    );

    // First-paint content for the live phase: the persisted doc bytes are
    // already in hand, so render THEM as the initial markdown instead of an
    // empty document + placeholder. CollabBridge attaches only after a
    // network round-trip (TURN credentials); that window used to flash a
    // blank editor on refresh. The attach then flushes the Y tree back in —
    // same content, so the swap is invisible (host-side twin of the
    // draft-first-paint fix in features/editor).
    const initialMd = useMemo(() => {
        if (phase.kind !== "live") return "";
        try {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, phase.bytes);
            const root = doc.getMap<unknown>(ROOT_KEY);
            if (root.size === 0) return "";
            return toMarkdown(deserializeRenderData(yNodeToJSON(root))) ?? "";
        } catch {
            return ""; // corrupt bytes -> empty first paint, attach recovers
        }
    }, [phase]);

    const handleRoomClosed = useCallback(() => {
        setClosedState({ reason: "dissolved", restored: false });
        if (phase.kind === "live") {
            void deactivateRoom(phase.room.id);
        }
    }, [phase]);

    // ---- Non-editor phases ----

    if (phase.kind === "loading") {
        return (
            <CollabShell>
                <span className="loading loading-dots loading-md" />
            </CollabShell>
        );
    }

    if (
        phase.kind === "invalid" ||
        phase.kind === "expired" ||
        phase.kind === "closed" ||
        phase.kind === "host"
    ) {
        const messageKey =
            phase.kind === "invalid"
                ? "collab.join.invalidLink"
                : phase.kind === "expired"
                  ? "collab.join.expired"
                  : phase.kind === "closed"
                    ? "collab.join.roomClosed"
                    : "collab.join.youAreHost";
        return (
            <CenterCard>
                <h3 className="text-sm font-semibold mb-2">
                    {t("collab.join.title")}
                </h3>
                <p className="text-sm text-base-content/60 mb-4">
                    {t(messageKey)}
                </p>
                <Link
                    href={phase.kind === "host" ? "/editor" : "/"}
                    className="btn btn-sm btn-ghost"
                >
                    {phase.kind === "host"
                        ? t("collab.join.backEditor")
                        : t("collab.join.backHome")}
                </Link>
            </CenterCard>
        );
    }

    if (phase.kind === "form") {
        return (
            <CenterCard>
                <form onSubmit={handleJoin}>
                    <h3 className="text-sm font-semibold mb-1">
                        {invite?.readonly
                            ? t("collab.join.viewerTitle")
                            : t("collab.join.title")}
                    </h3>
                    <p className="text-xs text-base-content/50 mb-4">
                        {invite?.readonly
                            ? t("collab.join.viewerSubtitle")
                            : t("collab.join.subtitle")}
                    </p>
                    {!invite?.readonly ? (
                        <>
                            <label className="block text-xs font-medium mb-1">
                                {t("collab.join.nameLabel")}
                            </label>
                            <input
                                type="text"
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder={t("collab.join.namePlaceholder")}
                                className="input input-bordered input-sm w-full mb-3"
                                autoComplete="off"
                            />
                        </>
                    ) : null}
                    {!invite?.linkSecret ? (
                        <>
                            <label className="block text-xs font-medium mb-1">
                                {t("collab.join.passwordLabel")}
                            </label>
                            <input
                                type="password"
                                value={formPassword}
                                onChange={(e) =>
                                    setFormPassword(e.target.value)
                                }
                                placeholder={t(
                                    "collab.join.passwordPlaceholder",
                                )}
                                className="input input-bordered input-sm w-full mb-3"
                            />
                        </>
                    ) : null}
                    {formError ? (
                        <p className="text-xs text-error mb-3">{formError}</p>
                    ) : null}
                    <button
                        type="submit"
                        disabled={joining}
                        className="btn btn-sm btn-primary w-full"
                    >
                        {joining
                            ? t("collab.join.joining")
                            : t("collab.join.submit")}
                    </button>
                </form>
            </CenterCard>
        );
    }

    if (phase.kind === "fetching") {
        const waitingHint =
            status?.signaling === "open"
                ? status.connectedPeers.length > 0
                    ? t("collab.join.fetchingDoc")
                    : status.roomPeers.length > 0
                      ? t("collab.join.connectingPeer")
                      : t("collab.join.noPeerOnline")
                : t("collab.join.connecting");
        return (
            <CenterCard>
                <h3 className="text-sm font-semibold mb-3">
                    {t("collab.join.title")}
                </h3>
                <div className="flex items-center gap-3 text-sm text-base-content/60">
                    <span className="loading loading-dots loading-sm" />
                    <span>{waitingHint}</span>
                </div>
            </CenterCard>
        );
    }

    // ---- Live editor ----

    const { room, bytes } = phase;
    const isViewer = room.role === "viewer";
    return (
        // Dual layer (see plugins/shared/use-visual-viewport-pin.ts): the
        // outer layer stays fullscreen and opaque; the inner one pins to the
        // visual viewport while the software keyboard is up so the
        // quick-input bar sits exactly on the keyboard's top edge.
        <div className="fixed inset-0 bg-base-100 text-base-content overflow-hidden">
            <div
                className="absolute inset-x-0 flex flex-col"
                style={
                    keyboardPin
                        ? ({
                              top: keyboardPin.top,
                              height: keyboardPin.height,
                              "--kb-safe-bottom": "0px",
                          } as React.CSSProperties)
                        : { top: 0, height: "100%" }
                }
            >
            {/* Header lives INSIDE the provider (which renders no DOM of its
                own — pure context) so its centered InsertToolbar can reach the
                editor store via useEditorStoreApi. */}
            <DOMDProvider
                editable={!isViewer}
                initMd={initialMd}
                placeholder={t("editor.placeholder")}
                imageLoader={collabImageLoader}
                codeTokenizer={tokenize}
                inlineRules={appInlineRules}
                codeBeautify={beautify}
                renderComponent={CustomRender}
                mode="rich"
            >
                {/* Same input affordances as the host editor: format
                    keystrokes (viewer-safe — they bail on a read-only store)
                    and the persisted rich/markdown mode + Cmd+/ toggle. */}
                <FormatShortcuts />
                <ModeController />
                {/* z-40 lifts the bar above the document layer: the centered
                    `-translate-*` cluster opens a local stacking context, so
                    without it the format popover loses to the table plugin's
                    `relative` root (same fix as the host editor's bar). */}
                <header className="relative z-40 shrink-0 h-10 flex items-center justify-between gap-2 px-3 bg-base-200 border-b border-base-content/15 select-none">
                    <BrandMark />
                    {/* macOS Notes-style centered cluster, aligned with the
                        host editor: format menu + insert entries. Viewers are
                        read-only, so they get none. Hidden on small screens
                        (no room; mobile inserts ride the keyboard bar). */}
                    {!isViewer ? (
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-0.5 max-md:hidden">
                            <FormatDropdown />
                            <span
                                aria-hidden
                                className="h-3.5 w-px bg-base-content/15 mr-1.5"
                            />
                            <InsertToolbar />
                        </div>
                    ) : null}
                    <div className="flex items-center gap-2 min-w-0">
                        {versioningHandle && !roomClosed ? (
                            <SidePanelTrigger panel="versioning">
                                <button
                                    className="btn btn-xs btn-ghost gap-1 text-base-content/60 shrink-0"
                                    title={t("versioning.title")}
                                >
                                    <HistoryIcon className="size-3.5" />
                                    {`${t("versioning.button")} · ${peers.length + 1}`}
                                </button>
                            </SidePanelTrigger>
                        ) : null}
                        {roomClosed ? (
                            <span className="badge badge-sm badge-warning badge-soft">
                                {t("collab.closedBadge")}
                            </span>
                        ) : status?.signaling !== "open" ? (
                            // Who is online lives in the collaboration panel;
                            // the header only surfaces connectivity trouble.
                            <span className="text-xs text-base-content/50 truncate">
                                {t("collab.reconnecting")}
                            </span>
                        ) : null}
                        {isViewer ? (
                            <span className="badge badge-sm badge-soft shrink-0">
                                {t("collab.viewerBadge")}
                            </span>
                        ) : (
                            <span
                                className="badge badge-sm border-0 gap-1.5 font-medium shrink-0"
                                style={{
                                    color: room.color,
                                    background: `color-mix(in srgb, ${room.color} 12%, transparent)`,
                                }}
                            >
                                <span
                                    className="inline-block size-1.5 rounded-full"
                                    style={{ background: room.color }}
                                />
                                {room.displayName}
                            </span>
                        )}
                        {!isViewer ? (
                            <CollabMoreMenu contentRef={contentRef} />
                        ) : null}
                    </div>
                </header>

                {closedState ? (
                    <div className="shrink-0 px-3 py-1.5 text-xs bg-warning text-warning-content border-b border-warning/20">
                        {t(
                            closedState.reason === "expired"
                                ? isViewer
                                    ? "collab.expiredBannerViewer"
                                    : "collab.expiredBanner"
                                : isViewer
                                  ? "collab.closedBannerViewer"
                                  : "collab.closedBanner",
                        )}
                    </div>
                ) : null}

                {!isViewer ? <ImageDropHandler /> : null}
                {!roomClosed ? (
                    <CollabBridge
                        room={room}
                        initialDocBytes={bytes}
                        onPeers={setPeers}
                        onStatus={setStatus}
                        onRoomClosed={handleRoomClosed}
                        onVersioning={setVersioningHandle}
                    />
                ) : (
                    // Dead room (dissolved or expired): no network, but keep
                    // mirroring edits into the persisted local copy.
                    // Mid-session death seeds from the live editor
                    // (bytes=null); a reopened link hydrates the empty
                    // editor from the stored bytes.
                    <LocalCollabBridge
                        roomId={room.id}
                        initialDocBytes={
                            closedState?.restored ? bytes : null
                        }
                    />
                )}
                <SidePanelHost
                    id="collab-side-panel"
                    panel={
                        versioningOpen && versioningHandle ? (
                            <VersioningPanel
                                handle={versioningHandle}
                                selfClientId={room.clientId}
                                onlineClientIds={peers.map((p) => p.clientId)}
                                onClose={() => sidePanelApi.close("versioning")}
                                onHighlightsChange={setHighlightTargets}
                            />
                        ) : null
                    }
                >
                    <GuestEditorSurface
                        keyboardPin={keyboardPin}
                        contentRef={contentRef}
                    />
                </SidePanelHost>
                <RemoteCursors peers={roomClosed ? [] : peers} />
                {highlightTargets.length ? (
                    <AuthorHighlights targets={highlightTargets} />
                ) : null}
                {!isViewer ? <QuickInputBar pin={keyboardPin} /> : null}
            </DOMDProvider>
            </div>
        </div>
    );
}
