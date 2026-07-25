"use client";
/**
 * Live collaboration playground synced in realtime over BroadcastChannel:
 * typing in any pane appears in every other one burst by burst (op-level
 * replay, O(change) rendering), with colored remote carets (presence).
 *
 * Tab roles (negotiated via Web Locks, see ./tab-role.ts): the first tab is
 * the *primary* and renders the unique Alice+Bob split screen; every
 * additional tab joins as exactly ONE new collaborator (Carol, Dave, …) with
 * its own color. Guest identities are never persisted — closing the tab
 * frees the identity, and once all tabs are closed the next open is
 * Alice+Bob again. The "add collaborator" button simply opens a new tab.
 *
 * Shared-origin discipline: the primary's Alice creates the doc (or
 * restores it from localStorage) and persists it immediately; Bob and every
 * guest tab restore from the same persisted bytes — all clients share the
 * same Yjs item identities. Attach re-reads storage at mount time, so
 * StrictMode remounts and refreshes never fork the origin. Reset is
 * broadcast on a control channel so guest tabs reload against the fresh
 * document instead of merging the old one back.
 *
 * Requires @do-md/core-react >= 0.4.0 (applyExternalRenderDataOps / caret
 * exposure); with an older core, attach throws and the page shows an
 * upgrade notice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { DOMD, DOMDProvider, useEditorStoreApi } from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import { beautify } from "@/common/lib/beautify";
import { docFromBase64 } from "@/plugins/collaboration/crdt-sync";
import {
    attachRealtimeSync,
    type RealtimePeer,
    type RealtimeSyncHandle,
} from "@/plugins/collaboration/realtime-sync";
import { RemoteCursors } from "@/plugins/collaboration/realtime-sync/remote-cursors";
import { negotiateTabRole, type TabRole } from "./tab-role";

const ROOM = "domd-live-demo";
const STATE_KEY = "domd-live-playground:state";
const CONTROL_CHANNEL = "domd-live-playground:control";

interface RoleConfig {
    name: string;
    /** Peer accent color — muted so carets/labels read clearly without glare. */
    color: string;
    /** Origin owner: responsible for creating the doc and persisting it. */
    isOriginOwner: boolean;
}

const ALICE: RoleConfig = { name: "Alice", color: "#bf616a", isOriginOwner: true };
const BOB: RoleConfig = { name: "Bob", color: "#5e81ac", isOriginOwner: false };

/** Guest identities for extra tabs — muted tones, distinct from Alice/Bob. */
const GUEST_POOL: { name: string; color: string }[] = [
    { name: "Carol", color: "#7d9367" },
    { name: "Dave", color: "#d08770" },
    { name: "Erin", color: "#9d7bab" },
    { name: "Frank", color: "#5f9b8c" },
    { name: "Grace", color: "#a08072" },
    { name: "Heidi", color: "#ab8f56" },
    { name: "Ivan", color: "#718799" },
    { name: "Judy", color: "#af6b84" },
];

const guestConfig = (index: number): RoleConfig => {
    const base = GUEST_POOL[index % GUEST_POOL.length];
    const round = Math.floor(index / GUEST_POOL.length);
    return {
        name: round > 0 ? `${base.name} ${round + 1}` : base.name,
        color: base.color,
        isOriginOwner: false,
    };
};

const loadState = (): string | null => {
    try {
        return localStorage.getItem(STATE_KEY);
    } catch {
        return null;
    }
};
const saveState = (b64: string) => {
    try {
        localStorage.setItem(STATE_KEY, b64);
    } catch {
        // ignore
    }
};

function BackIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
        </svg>
    );
}

function PlusIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Inside the provider: bridges store <-> realtime sync <-> persistence.
// ---------------------------------------------------------------------------

function LiveBridge({
    config,
    onPeers,
    onReady,
    onError,
}: {
    config: RoleConfig;
    onPeers: (peers: RealtimePeer[]) => void;
    onReady: () => void;
    onError: (message: string) => void;
}) {
    const store = useEditorStoreApi();
    const attachedRef = useRef(false);

    useEffect(() => {
        if (!store || attachedRef.current) return;
        attachedRef.current = true;

        let handle: RealtimeSyncHandle | null = null;
        let persistTimer: ReturnType<typeof setTimeout> | undefined;
        let unsubPeers = () => {};
        const onDocUpdate = () => {
            if (!config.isOriginOwner || !handle) return;
            clearTimeout(persistTimer);
            const h = handle;
            persistTimer = setTimeout(() => saveState(h.getStateBase64()), 500);
        };

        try {
            // Shared origin: read storage at attach time (StrictMode remounts
            // and refreshes never fork).
            const stored = loadState();
            handle = attachRealtimeSync(store as never, {
                room: ROOM,
                name: config.name,
                color: config.color,
                doc: stored ? docFromBase64(stored) : undefined,
            });
            // The origin owner persists immediately (anchoring the Yjs item
            // identities for latecomers to clone).
            if (config.isOriginOwner) saveState(handle.getStateBase64());
            handle.doc.on("update", onDocUpdate);
            unsubPeers = handle.subscribePeers(onPeers);
            onReady();
        } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
        }

        return () => {
            clearTimeout(persistTimer);
            if (handle) {
                handle.doc.off("update", onDocUpdate);
                unsubPeers();
                handle.dispose();
            }
            attachedRef.current = false;
        };
        // Attach runs once; the only dependency is the store being ready.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store]);

    return null;
}

// ---------------------------------------------------------------------------
// A single client pane.
// ---------------------------------------------------------------------------

function LivePane({
    config,
    initialMd,
    onReady,
    onError,
}: {
    config: RoleConfig;
    initialMd: string;
    onReady: () => void;
    onError: (message: string) => void;
}) {
    const { t } = useTranslation();
    const [peers, setPeers] = useState<RealtimePeer[]>([]);

    return (
        <section className="flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden bg-base-100 border border-base-content/10 shadow-sm">
            <header className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 bg-base-200/60 border-b border-base-content/10">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className="badge badge-sm border-0 gap-1.5 font-medium"
                        style={{
                            color: config.color,
                            background: `color-mix(in srgb, ${config.color} 12%, transparent)`,
                        }}
                    >
                        <span
                            className="inline-block size-1.5 rounded-full"
                            style={{ background: config.color }}
                        />
                        {config.name}
                    </span>
                    <span className="text-xs text-base-content/50 truncate">
                        {peers.length
                            ? t("live.online", {
                                  names: peers
                                      .map((p) => p.name)
                                      .join(" · "),
                              })
                            : t("live.waiting")}
                    </span>
                </div>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                <DOMDProvider
                    editable={true}
                    initMd={config.isOriginOwner ? initialMd : ""}
                    placeholder={t("live.placeholder")}
                    codeTokenizer={tokenize}
                    codeBeautify={beautify}
                >
                    <LiveBridge
                        config={config}
                        onPeers={setPeers}
                        onReady={onReady}
                        onError={onError}
                    />
                    <DOMD />
                    <RemoteCursors peers={peers} />
                </DOMDProvider>
            </div>
        </section>
    );
}

function PaneLoader() {
    return (
        <section className="flex-1 min-w-0 flex items-center justify-center rounded-xl border border-base-content/10 bg-base-100 shadow-sm">
            <span className="loading loading-dots loading-sm" />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Main view.
// ---------------------------------------------------------------------------

export function LivePlaygroundApp() {
    const { t } = useTranslation();
    const [sessionKey, setSessionKey] = useState(0);
    const [aliceReady, setAliceReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** null while negotiating (covers SSR / first paint too). */
    const [role, setRole] = useState<TabRole | null>(null);
    const [guestSeedReady, setGuestSeedReady] = useState(false);
    const controlRef = useRef<BroadcastChannel | null>(null);

    const initialMd = useMemo(
        () =>
            [
                `# ${t("live.seedHeading")}`,
                "",
                t("live.seedIntro"),
                "",
                t("live.seedCarets"),
            ].join("\n"),
        [t],
    );

    // Resolve this tab's role once (client only).
    useEffect(() => {
        let active = true;
        void negotiateTabRole().then((r) => {
            if (active) setRole(r);
        });
        return () => {
            active = false;
        };
    }, []);

    // Cross-tab reset: the primary announces a reset; guest tabs reload and
    // rejoin against the fresh document (instead of merging the old one back).
    useEffect(() => {
        if (!role) return;
        const channel = new BroadcastChannel(CONTROL_CHANNEL);
        if (role.kind === "guest") {
            channel.onmessage = (e: MessageEvent) => {
                if ((e.data as { t?: string } | null)?.t === "reset") {
                    window.location.reload();
                }
            };
        }
        controlRef.current = channel;
        return () => {
            controlRef.current = null;
            channel.close();
        };
    }, [role]);

    // Guest tabs join an existing doc: wait briefly for the primary's
    // persisted state so the shared origin is never forked (covers the
    // reset race), then degrade to attaching anyway.
    useEffect(() => {
        if (role?.kind !== "guest") return;
        let cancelled = false;
        const waitForSeed = async () => {
            for (let i = 0; i < 30 && !cancelled; i += 1) {
                await new Promise((r) => setTimeout(r, 100));
                if (loadState() !== null) break;
            }
            if (!cancelled) setGuestSeedReady(true);
        };
        void waitForSeed();
        return () => {
            cancelled = true;
        };
    }, [role]);

    const reset = useCallback(() => {
        try {
            localStorage.removeItem(STATE_KEY);
        } catch {
            // ignore
        }
        controlRef.current?.postMessage({ t: "reset" });
        setAliceReady(false);
        setError(null);
        setSessionKey((k) => k + 1);
    }, []);

    const addCollaborator = useCallback(() => {
        window.open(window.location.href, "_blank");
    }, []);

    if (!role) {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-base-100">
                <span className="loading loading-dots loading-md" />
            </div>
        );
    }

    const isPrimary = role.kind === "primary";

    return (
        <div className="fixed inset-0 flex flex-col bg-base-100 text-base-content overflow-hidden">
            <header className="shrink-0 h-12 flex items-center justify-between px-3 md:px-4 bg-base-200 border-b border-base-300">
                <div className="flex items-center gap-2 min-w-0">
                    <Link
                        href="/playground"
                        className="btn btn-ghost btn-xs btn-circle"
                        aria-label={t("live.back")}
                    >
                        <BackIcon className="size-4" />
                    </Link>
                    <span className="font-semibold text-sm truncate">
                        {t("live.headerTitle")}
                    </span>
                    <span className="hidden sm:inline text-xs text-base-content/45 truncate">
                        {t("live.headerSubtitle")}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="btn btn-xs btn-accent gap-1"
                        onClick={addCollaborator}
                        title={t("live.addPeerTitle")}
                    >
                        <PlusIcon className="size-3.5" />
                        {t("live.addPeer")}
                    </button>
                    {isPrimary ? (
                        <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            onClick={reset}
                            title={t("live.resetTitle")}
                        >
                            {t("live.reset")}
                        </button>
                    ) : null}
                </div>
            </header>

            {error ? (
                <div className="m-3 md:m-4 alert alert-warning text-sm">
                    <span>
                        {t("live.unavailable", { message: error })}
                        {error.includes("0.4.0")
                            ? ` ${t("live.upgradeHint")}`
                            : ""}
                    </span>
                </div>
            ) : null}

            <main className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 p-3 md:p-4">
                {isPrimary ? (
                    <>
                        <LivePane
                            key={`alice-${sessionKey}`}
                            config={ALICE}
                            initialMd={initialMd}
                            onReady={() => setAliceReady(true)}
                            onError={setError}
                        />
                        {aliceReady ? (
                            <LivePane
                                key={`bob-${sessionKey}`}
                                config={BOB}
                                initialMd={initialMd}
                                onReady={() => {}}
                                onError={setError}
                            />
                        ) : (
                            <PaneLoader />
                        )}
                    </>
                ) : guestSeedReady ? (
                    <LivePane
                        key={`guest-${role.index}-${sessionKey}`}
                        config={guestConfig(role.index)}
                        initialMd={initialMd}
                        onReady={() => {}}
                        onError={setError}
                    />
                ) : (
                    <PaneLoader />
                )}
            </main>
        </div>
    );
}
