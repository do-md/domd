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
    useRenderData,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { BrandMark } from "@/common/components/brand-mark";
import { tokenize } from "@/common/lib/prism";
import { beautify } from "@/common/lib/beautify";
// Direct module import (not the features/editor barrel) to avoid a cycle:
// editor's barrel imports from features/collaboration.
import { ImageDropHandler } from "@/features/editor/hooks/use-image-drop";
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

type Phase =
    | { kind: "loading" }
    | { kind: "invalid" }
    | { kind: "expired" }
    | { kind: "closed" }
    | { kind: "host" } // this browser hosts the room — joining would clobber it
    | { kind: "form" }
    | { kind: "fetching"; room: RoomRecord }
    | { kind: "live"; room: RoomRecord; bytes: Uint8Array };

function GuestEditorSurface({
    keyboardPin,
}: {
    keyboardPin: ViewportPin | null;
}) {
    const editor = useEditor();
    const isEditable = useEditorStore((store) => store.isEditable);
    const renderData = useRenderData();
    const domdRef = useRef<HTMLDivElement>(null);
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
                if (domdRef.current?.contains(e.target as Node)) return;
                editor?.focus();
            }}
        >
            <div className="max-w-3xl mx-auto px-6 py-8">
                <div ref={domdRef}>
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
    const [showVersioning, setShowVersioning] = useState(false);
    const [highlightTargets, setHighlightTargets] = useState<
        HighlightTarget[]
    >([]);
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
            transport = createWebRtcTransport({
                signalingUrl: getSignalingUrl(),
                roomId: room.id,
                // Temporary identity for the bootstrap connection; the
                // durable clientId is used once the editor session attaches.
                clientId: generateClientId(),
                key: room.key,
                exp: room.exp,
                iceServers,
                onStatusChange: setStatus,
            });
            const bytes = await fetchInitialState(transport, {
                signal: controller.signal,
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
            <header className="shrink-0 h-10 flex items-center justify-between gap-2 px-3 bg-base-200 border-b border-base-300 select-none">
                <BrandMark />
                <div className="flex items-center gap-2 min-w-0">
                    {versioningHandle && !roomClosed ? (
                        <button
                            onClick={() => setShowVersioning((v) => !v)}
                            className="btn btn-xs btn-ghost gap-1 text-base-content/60 shrink-0"
                            title={t("versioning.title")}
                        >
                            <HistoryIcon className="size-3.5" />
                            {`${t("versioning.button")} · ${peers.length + 1}`}
                        </button>
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

            <DOMDProvider
                editable={!isViewer}
                initMd={initialMd}
                placeholder={t("editor.placeholder")}
                imageLoader={collabImageLoader}
                codeTokenizer={tokenize}
                codeBeautify={beautify}
            >
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
                <GuestEditorSurface keyboardPin={keyboardPin} />
                <RemoteCursors peers={roomClosed ? [] : peers} />
                {highlightTargets.length ? (
                    <AuthorHighlights targets={highlightTargets} />
                ) : null}
                {!isViewer ? <QuickInputBar pin={keyboardPin} /> : null}
            </DOMDProvider>

            {showVersioning && versioningHandle ? (
                <VersioningPanel
                    handle={versioningHandle}
                    selfClientId={room.clientId}
                    onlineClientIds={peers.map((p) => p.clientId)}
                    topClassName="top-10"
                    onClose={() => {
                        setShowVersioning(false);
                        setHighlightTargets([]);
                    }}
                    onHighlightsChange={setHighlightTargets}
                />
            ) : null}
            </div>
        </div>
    );
}
