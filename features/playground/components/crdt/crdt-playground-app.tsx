"use client";
/**
 * CRDT conflict-free merge playground: a split screen that simulates two
 * clients (A / B).
 *
 * Flow (mirrors a real multi-client setup):
 * - A and B each own an independent EditorStore + Y.Doc (attachCrdtSync keeps
 *   them mirrored both ways);
 * - each client "publishes" its state to localStorage (CRDT base64 + markdown);
 * - the "Merge" button reads the *other* client's latest published state and
 *   folds it in via Y.applyUpdate (yjs conflict-free merge); the merged result
 *   is flushed back into the store by the plugin;
 * - both sides can keep editing independently, merge in either direction, or
 *   stay put;
 * - "Force sync" = A merges B -> A publishes -> B merges A's new state -> both
 *   converge.
 *
 * Shared origin: a CRDT merge requires a shared origin (two docs each created
 * independently have all-distinct uuids, so a merge duplicates the whole
 * document). On first run A creates the doc, serializes it, and clones it to B
 * — mirroring the real world where a document is created on one device and
 * synced to another.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { DOMD, DOMDProvider, useEditorStoreApi } from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import { beautify } from "@/common/lib/beautify";
import {
    attachCrdtSync,
    docFromBase64,
    type CrdtSyncHandle,
} from "@/plugins/collaboration/crdt-sync";
import {
    type CrdtClientId,
    clearAllSnapshots,
    loadClientSnapshot,
    saveClientSnapshot,
} from "../../lib/crdt-storage";

interface PaneApi {
    /** Read the other client's state from storage and fold it in (false = the other side has not published yet). */
    mergeFromOther: () => boolean;
    /** Publish this client's current state to storage immediately. */
    publish: () => void;
}

interface PaneStatus {
    savedAt: number | null;
    stateBytes: number;
}

/** A subtle theme-color accent per client so A and B are instantly told apart. */
const CLIENT_ACCENT: Record<CrdtClientId, { dot: string; badge: string }> = {
    A: { dot: "bg-warning", badge: "badge-warning" },
    B: { dot: "bg-info", badge: "badge-info" },
};

function SyncIcon({ className }: { className?: string }) {
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
            <path d="M4 12a8 8 0 0 1 14-5.3L21 9" />
            <path d="M21 4v5h-5" />
            <path d="M20 12a8 8 0 0 1-14 5.3L3 15" />
            <path d="M3 20v-5h5" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Inside the provider: bridges store <-> Y.Doc <-> localStorage.
// ---------------------------------------------------------------------------

function CrdtBridge({
    clientId,
    otherId,
    initialStateB64,
    onReady,
    onStatus,
}: {
    clientId: CrdtClientId;
    otherId: CrdtClientId;
    /** Starting doc state at mount (own storage, or the bootstrap clone); null = build a new doc from the store content. */
    initialStateB64: string | null;
    onReady: (api: PaneApi) => void;
    onStatus: (status: PaneStatus) => void;
}) {
    const store = useEditorStoreApi();
    const attachedRef = useRef(false);

    useEffect(() => {
        if (!store || attachedRef.current) return;
        attachedRef.current = true;

        // Prefer the client's *own* storage over the props snapshot for the
        // starting state. StrictMode unmounts and remounts the effect; if the
        // remount rebuilt "new empty doc, then fill", it would mint a fresh set
        // of Yjs item identities — same content/uuid but different items — no
        // longer sharing an origin with the other side (which cloned the bytes
        // of the first publish). A later merge would then land as a concurrent
        // set on the top-level Y.Map = whole-value LWW, and the loser's entire
        // tree silently disappears (the "B loses its edits after merging A"
        // bug). Reading storage before attach restores the same item identities
        // on remount/refresh, so the origin never forks.
        const storedB64 = loadClientSnapshot(clientId)?.state ?? initialStateB64;
        const doc = storedB64 ? docFromBase64(storedB64) : undefined;
        const handle: CrdtSyncHandle = attachCrdtSync(
            store as never,
            doc ? { doc } : {},
        );

        const publish = () => {
            const state = handle.getStateBase64();
            saveClientSnapshot(clientId, {
                state,
                md: (store as never as { toMarkdown(): string }).toMarkdown(),
                savedAt: Date.now(),
            });
            onStatus({ savedAt: Date.now(), stateBytes: state.length });
        };

        // Editing produces doc updates -> debounced publish (merges use the
        // synchronous publish below).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onUpdate = () => {
            clearTimeout(timer);
            timer = setTimeout(publish, 400);
        };
        handle.doc.on("update", onUpdate);

        // First publish, so the other side can merge from us at any time.
        publish();

        onReady({
            mergeFromOther: () => {
                const other = loadClientSnapshot(otherId);
                if (!other) return false;
                handle.applyRemoteBase64(other.state);
                publish(); // publish the merged result at once (Force sync relies on synchronous semantics)
                return true;
            },
            publish,
        });

        return () => {
            clearTimeout(timer);
            handle.doc.off("update", onUpdate);
            handle.dispose();
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

function ClientPane({
    clientId,
    otherId,
    initialMd,
    initialStateB64,
    onReady,
    onMergeClick,
}: {
    clientId: CrdtClientId;
    otherId: CrdtClientId;
    initialMd: string;
    initialStateB64: string | null;
    onReady: (api: PaneApi) => void;
    onMergeClick: () => void;
}) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<PaneStatus>({
        savedAt: null,
        stateBytes: 0,
    });
    const accent = CLIENT_ACCENT[clientId];

    return (
        <section className="flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden bg-base-100 border border-base-content/10 shadow-sm">
            <header className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 bg-base-200/60 border-b border-base-content/10">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className={`badge badge-sm badge-soft ${accent.badge} gap-1.5 font-medium`}
                    >
                        <span
                            className={`inline-block size-1.5 rounded-full ${accent.dot}`}
                        />
                        {t("crdt.client", { id: clientId })}
                    </span>
                    <span className="text-xs text-base-content/50 truncate tabular-nums">
                        {status.savedAt
                            ? t("crdt.saved", {
                                  time: new Date(
                                      status.savedAt,
                                  ).toLocaleTimeString(),
                                  size: (status.stateBytes / 1024).toFixed(1),
                              })
                            : t("crdt.notSaved")}
                    </span>
                </div>
                <button
                    type="button"
                    className="btn btn-xs btn-soft"
                    onClick={onMergeClick}
                    title={t("crdt.mergeTitle", {
                        other: otherId,
                        self: clientId,
                    })}
                >
                    {t("crdt.merge", { id: otherId })}
                </button>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                <DOMDProvider
                    editable={true}
                    initMd={initialStateB64 ? "" : initialMd}
                    placeholder={t("crdt.placeholder")}
                    codeTokenizer={tokenize}
                    codeBeautify={beautify}
                >
                    <CrdtBridge
                        clientId={clientId}
                        otherId={otherId}
                        initialStateB64={initialStateB64}
                        onReady={onReady}
                        onStatus={setStatus}
                    />
                    <DOMD />
                </DOMDProvider>
            </div>
        </section>
    );
}

// ---------------------------------------------------------------------------
// Main view.
// ---------------------------------------------------------------------------

type BootPhase =
    | { phase: "loading" }
    | {
          phase: "ready";
          aState: string | null;
          bState: string | null;
          /** When B has no state of its own, wait for A to publish, then clone A's state (shared origin). */
          bNeedsBootstrap: boolean;
      };

export function CrdtPlaygroundApp() {
    const { t } = useTranslation();
    const [sessionKey, setSessionKey] = useState(0);
    const [boot, setBoot] = useState<BootPhase>({ phase: "loading" });
    /** In the bootstrap case, the initial state handed to B (only exists after A's first publish). */
    const [bBootstrapState, setBBootstrapState] = useState<string | null>(null);

    const paneApis = useRef<Partial<Record<CrdtClientId, PaneApi>>>({});
    /** Ref mirror of boot.bNeedsBootstrap (read by event callbacks to avoid stale closure capture). */
    const bNeedsBootstrapRef = useRef(false);
    const [toast, setToast] = useState<string | null>(null);

    const flash = useCallback((msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(null), 1800);
    }, []);

    const initialMd = useMemo(
        () =>
            [
                `# ${t("crdt.seedHeading")}`,
                "",
                t("crdt.seedIntro"),
                "",
                t("crdt.seedTry"),
            ].join("\n"),
        [t],
    );

    // Boot: read whatever state each side already has (client-side only).
    useEffect(() => {
        const a = loadClientSnapshot("A");
        const b = loadClientSnapshot("B");
        bNeedsBootstrapRef.current = !b;
        setBoot({
            phase: "ready",
            aState: a?.state ?? null,
            bState: b?.state ?? null,
            bNeedsBootstrap: !b,
        });
        setBBootstrapState(null);
    }, [sessionKey]);

    const onPaneReady = useCallback(
        (id: CrdtClientId) => (api: PaneApi) => {
            paneApis.current[id] = api;
            // Once A is ready and has published, if B needs bootstrapping,
            // clone B from the state A just published.
            if (id === "A" && bNeedsBootstrapRef.current) {
                const a = loadClientSnapshot("A");
                if (a) {
                    bNeedsBootstrapRef.current = false;
                    setBBootstrapState(a.state);
                }
            }
        },
        [],
    );

    const mergeInto = useCallback(
        (id: CrdtClientId) => {
            const other = id === "A" ? "B" : "A";
            const ok = paneApis.current[id]?.mergeFromOther();
            flash(
                ok
                    ? t("crdt.toastMerged", { id, other })
                    : t("crdt.toastNothing"),
            );
        },
        [flash, t],
    );

    const forceSync = useCallback(() => {
        // A merges B (and publishes) -> B merges A's new state -> both converge.
        paneApis.current.A?.mergeFromOther();
        paneApis.current.B?.mergeFromOther();
        flash(t("crdt.toastForced"));
    }, [flash, t]);

    const reset = useCallback(() => {
        clearAllSnapshots();
        paneApis.current = {};
        setBoot({ phase: "loading" });
        setSessionKey((k) => k + 1);
        flash(t("crdt.toastReset"));
    }, [flash, t]);

    if (boot.phase === "loading") {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-base-100">
                <span className="loading loading-dots loading-md" />
            </div>
        );
    }

    const bInitialState = boot.bState ?? bBootstrapState;
    const bWaitingBootstrap = boot.bNeedsBootstrap && !bBootstrapState;

    return (
        <div className="fixed inset-0 flex flex-col bg-base-100 text-base-content overflow-hidden">
            <header className="shrink-0 h-12 flex items-center justify-between px-3 md:px-4 bg-base-200 border-b border-base-300">
                <div className="flex items-center gap-2 min-w-0">
                    <Link
                        href="/playground"
                        className="btn btn-ghost btn-xs btn-circle"
                        aria-label={t("crdt.back")}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="size-4"
                            aria-hidden="true"
                        >
                            <path d="M19 12H5" />
                            <path d="m12 19-7-7 7-7" />
                        </svg>
                    </Link>
                    <span className="font-semibold text-sm truncate">
                        {t("crdt.headerTitle")}
                    </span>
                    <span className="hidden sm:inline text-xs text-base-content/45 truncate">
                        {t("crdt.headerSubtitle")}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="btn btn-xs btn-accent gap-1"
                        onClick={forceSync}
                        title={t("crdt.forceSyncTitle")}
                    >
                        <SyncIcon className="size-3.5" />
                        {t("crdt.forceSync")}
                    </button>
                    <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={reset}
                        title={t("crdt.resetTitle")}
                    >
                        {t("crdt.reset")}
                    </button>
                </div>
            </header>

            <main className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 p-3 md:p-4">
                <ClientPane
                    key={`A-${sessionKey}`}
                    clientId="A"
                    otherId="B"
                    initialMd={initialMd}
                    initialStateB64={boot.aState}
                    onReady={onPaneReady("A")}
                    onMergeClick={() => mergeInto("A")}
                />
                {bWaitingBootstrap ? (
                    <section className="flex-1 min-w-0 flex items-center justify-center rounded-xl border border-base-content/10 bg-base-100 shadow-sm">
                        <span className="loading loading-dots loading-sm" />
                    </section>
                ) : (
                    <ClientPane
                        key={`B-${sessionKey}`}
                        clientId="B"
                        otherId="A"
                        initialMd={initialMd}
                        initialStateB64={bInitialState}
                        onReady={onPaneReady("B")}
                        onMergeClick={() => mergeInto("B")}
                    />
                )}
            </main>

            {toast ? (
                <div className="toast toast-center toast-bottom z-50">
                    <div className="alert border border-base-content/10 bg-base-200 text-base-content shadow-lg py-2 px-4 text-sm">
                        {toast}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
