"use client";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    DOMD,
    toMarkdown,
    useRenderData,
    useEditorStoreApi,
    useEditorStore,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { useTranslation } from "react-i18next";
import { BrandMark } from "@/common/components/brand-mark";
import { InsertToolbar } from "@/common/components/insert-toolbar";
import {
    SidePanelHost,
    SidePanelTrigger,
    useSidePanelActive,
} from "@/common/components/side-panel";
import { FormatDropdown } from "@/common/components/format-dropdown";
import { FormatShortcuts } from "@/common/components/format-shortcuts";
import { TocStoreProvider } from "@do-md/toc";
import {
    TocController,
    TOC_TOGGLE_SHORTCUT,
} from "@/features/editor/components/toc-panel";
import {
    FindBar,
    FindMenuItem,
} from "@/features/editor/components/find-bar";
import { SearchStoreProvider } from "@do-md/search";
import { getGrammarVersion, subscribeGrammarLoad } from "@/common/lib/prism";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";
import { isTauri } from "@/common/lib/platform";
import {
    MODE_TOGGLE_SHORTCUT,
    toggleEditorMode,
} from "../lib/editor-mode";
import { tauriCore } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";
import { useAutoSave } from "../hooks/use-auto-save";
import { useLocalDraft } from "../hooks/use-local-draft";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { saveDocument } from "../lib/save-document";
import { exportToPdf } from "../lib/export-pdf";
import type { FileMeta } from "../lib/types";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";
import { QuickInputBar } from "@/plugins/toolbar/quick-input-bar";
import { useVisualViewportPin } from "@/plugins/shared/use-visual-viewport-pin";
import { PlusIcon } from "@/features/icons/plus-icon";

function TocListIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            className={className}
            aria-hidden="true"
        >
            <path d="M4 6h16M9 12h11M4 18h16" />
        </svg>
    );
}

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

function HistoryIcon({ className }: { className?: string }) {
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
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 3" />
        </svg>
    );
}

function SparklesIcon({ className }: { className?: string }) {
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
            <path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7L12 3z" />
            <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
        </svg>
    );
}

function UsersIcon({ className }: { className?: string }) {
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
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    );
}

export function Editor({
    meta,
    onMetaUpdate,
    onRequestOpenUrl,
    saveRef,
    collabActive = false,
    collabPeerCount = 0,
    onRequestShare,
    onRequestNew,
    versioningAvailable = false,
    aiAvailable = false,
    aiActive = false,
    sidePanel = null,
}: {
    meta: FileMeta;
    onMetaUpdate: (meta: FileMeta) => void;
    onRequestOpenUrl: () => void;
    saveRef: React.MutableRefObject<(() => Promise<boolean>) | null>;
    /** Realtime collaboration state (web mode only). */
    collabActive?: boolean;
    collabPeerCount?: number;
    onRequestShare?: () => void;
    onRequestNew?: () => void;
    /** Show the version-history trigger (present only while a collab
     *  session is attached — versioning data lives in the shared doc).
     *  The button itself drives the panel through the side-panel store. */
    versioningAvailable?: boolean;
    /** Show the AI collaboration trigger (web only). */
    aiAvailable?: boolean;
    /** AI collaboration enabled with at least one agent configured. */
    aiActive?: boolean;
    /** Side panel content for the SidePanelHost slot, resolved by the app
     *  from the side-panel store's active kind. Null = closed. */
    sidePanel?: React.ReactNode;
}) {
    const { t } = useTranslation();
    const renderData = useRenderData();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const store = useEditorStoreApi();
    const isEditable = useEditorStore((store) => store.isEditable);
    const mode = useEditorStore((store) => store.mode);
    const mac = useApplePlatform();
    // Which edge the single panel slot occupies is a property of the ACTIVE
    // panel: the outline opens from the left (matching its trigger's spot in
    // the bar), AI / versioning keep the right.
    const sidePanelSide =
        useSidePanelActive() === "toc" ? ("left" as const) : ("right" as const);

    const metaRef = useLatest(meta);
    const domdRef = useRef<HTMLDivElement>(null);
    const scrollAreaRef = useRef<HTMLDivElement>(null);

    // Software-keyboard geometry (iOS/Android). Non-null while the keyboard
    // is up; the inner layer below pins to it so the quick-input bar sits
    // exactly on the keyboard's top edge. Null on desktop -> static layout.
    const keyboardPin = useVisualViewportPin();

    // The keyboard shrinks the content area drastically — whenever the
    // pinned geometry changes, scroll the caret back into the visible
    // region. Scroll the INTERNAL container only; scrolling the layout
    // viewport on iOS introduces offsetTop drift.
    useEffect(() => {
        if (!keyboardPin) return;
        const container = scrollAreaRef.current;
        if (!container) return;
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        if (!container.contains(sel.anchorNode)) return;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        // A collapsed caret can report a zero rect (see CustomCursor); skip
        // rather than scroll to a bogus position.
        if (rect.width === 0 && rect.height === 0) return;
        const box = container.getBoundingClientRect();
        if (rect.bottom > box.bottom - 8) {
            container.scrollBy({ top: rect.bottom - (box.bottom - 8) + 24 });
        } else if (rect.top < box.top + 8) {
            container.scrollBy({ top: rect.top - (box.top + 8) - 24 });
        }
    }, [keyboardPin]);

    // Auto-focus once on mount. Currently disabled (the call is commented out)
    // — kept as a deliberate toggle. store.focus() records an intent instead of
    // touching the DOM, so it no longer needs to wait for the editor instance;
    // the ref keeps it from re-firing on a later doc swap.
    const didFocusRef = useRef(false);
    useEffect(() => {
        if (!store || didFocusRef.current) return;
        didFocusRef.current = true;
        // store.focus();
    }, [store]);

    useEffect(() => {
        // @ts-expect-error
        window.toMarkdown = () => {
            return toMarkdown(renderData);
        };
        // Debug/automation hook (same family as window.insertText below):
        // exposes the store so headless drivers can reach state and actions
        // that the rAF-debounced DOM selection sync never delivers in a
        // hidden tab (e.g. setCursorInfo_ to place the caret).
        // @ts-expect-error
        window.__domdStore = store;
    }, [store, renderData]);

    useEffect(() => {
        if (!store) return;
        {
            // 保留 aiInsertInCursor 这个名字（手敲惯了），实现就是 store.insertText。
            // @ts-expect-error
            window.aiInsertInCursor = (text: string) => {
                store.insertText(text);
            };
            // @ts-expect-error
            window.insertText = (text: string) => {
                store?.insertText(text);
            };
            // @ts-expect-error
            window.insertTexts = async (...texts: string) => {
                const SPEED = 1.0;

                const sleep = (ms: number) =>
                    new Promise((r) => setTimeout(r, ms * SPEED));
                const rand = (min: number, max: number) =>
                    min + Math.random() * (max - min);

                for (const chunk of texts) {
                    store?.insertText(chunk);
                    await sleep(rand(25, 60));
                }
            };
            // @ts-expect-error
            window.mockAI = async (text: string) => {
                const SPEED = 1.0;

                const content = text;

                const sleep = (ms: number) =>
                    new Promise((r) => setTimeout(r, ms * SPEED));
                const rand = (min: number, max: number) =>
                    min + Math.random() * (max - min);

                let i = 0;
                while (i < content.length) {
                    const chunkSize = 1 + Math.floor(Math.random() * 5); // 1..5
                    const chunk = content.slice(i, i + chunkSize);
                    store?.insertText(chunk);
                    i += chunkSize;

                    await sleep(rand(25, 60));
                }
            };
        }
    }, [store]);

    // Benchmark: signal once after the initial paint. initMd makes renderData
    // available synchronously on first render, so a single mount effect is enough.
    useEffect(() => {
        if (!isTauri()) return;
        const raf1 = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                tauriCore().then(({ invoke }) => {
                    invoke("benchmark_mark_ready").catch(() => { });
                });
            });
        });
        return () => cancelAnimationFrame(raf1);
    }, []);

    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        return () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        };
    }, []);

    const storeRef = useLatest(store);
    const getTitle = useCallback(() => {
        try {
            return storeRef.current?.getTitle() ?? "";
        } catch {
            return "";
        }
    }, [storeRef]);

    const doSave = useCallback(
        async (data: ReturnType<typeof useRenderData>) => {
            const md = toMarkdown(data) ?? "";
            const currentMeta = metaRef.current;
            setSaving(true);
            try {
                const result = await saveDocument(currentMeta, md, getTitle);
                if (!result.ok) return false;
                onMetaUpdate(result.meta);
                if (currentMeta.kind === "web") {
                    setSaved(true);
                    if (savedTimerRef.current)
                        clearTimeout(savedTimerRef.current);
                    savedTimerRef.current = setTimeout(() => {
                        setSaved(false);
                        savedTimerRef.current = null;
                    }, 2000);
                }
                return true;
            } finally {
                setSaving(false);
            }
        },
        [onMetaUpdate, metaRef, getTitle],
    );

    const doSaveRef = useRef(doSave);
    doSaveRef.current = doSave;
    const renderDataRef = useRef(renderData);
    renderDataRef.current = renderData;

    useAutoSave(meta, renderData, doSave);
    useLocalDraft(meta, renderData);

    useEffect(() => {
        saveRef.current = () => doSaveRef.current(renderDataRef.current);
        return () => {
            saveRef.current = null;
        };
    }, [saveRef]);

    // When a Prism grammar finishes loading, re-parse the doc so already-rendered
    // code blocks pick up the now-available syntax highlighting. Debounced so
    // multiple grammars loading back-to-back result in a single re-parse.
    // baseVersionRef captures the version at mount so previously-loaded grammars
    // (from earlier docs in this session) don't trigger a spurious initial reparse.
    const grammarVersion = useSyncExternalStore(
        subscribeGrammarLoad,
        getGrammarVersion,
        () => 0,
    );
    const baseVersionRef = useRef(grammarVersion);
    useEffect(() => {
        if (grammarVersion <= baseVersionRef.current) return;
        if (!store) return;
        const id = setTimeout(() => {
            const md = toMarkdown(renderDataRef.current) ?? "";
            store.resetMD(md);
        }, 50);
        return () => clearTimeout(id);
    }, [grammarVersion, store]);

    // Tauri: menu → Save
    useTauriEvent("menu-save", () => {
        doSaveRef.current(renderDataRef.current);
    });

    // Tauri: CLI → insert text. Driven from the Rust-side cli_server
    // (~/.domd/cli.sock). A blank new window has no children → no cursor →
    // store.insertText is a silent no-op. Seed via resetMD on first insert,
    // then fall through to incremental insertText.
    useTauriEvent<{ text: string }>("cli-insert", ({ text }) => {
        const isEmpty = (toMarkdown(renderDataRef.current) ?? "").length === 0;
        if (isEmpty && store) {
            store.resetMD(text);
            return;
        }
        // TODO(user): if there's an active range selection, delete it before
        // insertText so the new text replaces the selection (standard editor
        // behavior). store.insertText currently only handles the caret case.
        store?.insertText(text);
    });

    // Tauri: CLI → push selection snapshot whenever it changes. The Rust
    // cli_server reads from a HashMap keyed by window label so an AI agent
    // querying `selection` gets an instant synchronous answer.
    //
    // Debounced (60ms) — selection changes can arrive in bursts during drag.
    useEffect(() => {
        if (!isTauri() || !store) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const push = () => {
            try {
                const sel = store.getSelectionState();
                tauriCore().then(({ invoke }) => {
                    invoke("update_selection", { sel }).catch(() => { });
                });
            } catch {
                // getSelectionState may throw while user is still implementing
                // the body — swallow so the rest of the editor keeps working.
            }
        };
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(push, 60);
        };
        const unsubscribe = store.subscribe(schedule);
        // Initial push so the Rust state has something on first selection query.
        schedule();
        return () => {
            if (timer) clearTimeout(timer);
            unsubscribe?.();
        };
    }, [store]);

    // Tauri: CLI → push full content + dirty flag whenever the doc changes.
    // Debounced (150ms) since this serializes the whole renderData to markdown.
    const lastSavedMdRef = useRef<string>("");
    useEffect(() => {
        if (!isTauri()) return;
        // Treat the initial loaded content as the baseline for dirty detection.
        // Re-runs only when meta changes (new doc loaded into this window).
        lastSavedMdRef.current = toMarkdown(renderDataRef.current) ?? "";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meta]);
    useEffect(() => {
        if (!isTauri()) return;
        const handle = setTimeout(() => {
            const md = toMarkdown(renderData) ?? "";
            const isDirty = md !== lastSavedMdRef.current;
            tauriCore().then(({ invoke }) => {
                invoke("update_content", { content: md, isDirty }).catch(
                    () => { },
                );
            });
        }, 150);
        return () => clearTimeout(handle);
    }, [renderData]);

    // Tauri: CLI just saved this window to disk on our behalf. Update the
    // baseline so subsequent dirty checks compare against the saved content.
    useTauriEvent<string>("saved-by-cli", () => {
        lastSavedMdRef.current = toMarkdown(renderDataRef.current) ?? "";
        // Push an immediate clean-state update so AI sees has_unsaved_changes
        // flip to false without waiting for the debounce.
        tauriCore().then(({ invoke }) => {
            invoke("update_content", {
                content: lastSavedMdRef.current,
                isDirty: false,
            }).catch(() => { });
        });
    });

    // Also clear the dirty baseline after a successful FE-initiated save
    // (menu Save, autosave, web Save button) — keeps the dirty flag accurate
    // whoever did the saving.
    const prevSavingRef = useRef(saving);
    useEffect(() => {
        if (prevSavingRef.current && !saving) {
            lastSavedMdRef.current = toMarkdown(renderDataRef.current) ?? "";
        }
        prevSavingRef.current = saving;
    }, [saving]);

    // Web: Cmd/Ctrl+S
    useEffect(() => {
        if (isTauri()) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                doSaveRef.current(renderDataRef.current);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    // No beforeunload guard: the local draft (use-local-draft) mirrors the
    // current document continuously, so a reload restores it instead of
    // losing work — the "Reload site?" prompt would be pure friction.

    const showSaveBar = meta.kind === "web";

    return (
        // Two layers (see plugins/shared/use-visual-viewport-pin.ts): the
        // outer one stays fullscreen and opaque (iOS can pan the layout
        // viewport while the keyboard is up — whatever peeks through must be
        // ourselves); the inner one pins to the visual viewport so the
        // quick-input bar rides the keyboard's top edge. --kb-safe-bottom
        // zeroes the safe-area padding while the keyboard covers the home
        // indicator.
        // The domd-editor-* classes are print anchors: the `@media print`
        // rules in globals.css unlock this fixed/overflow layout into a
        // plain document flow so native printing (desktop Export PDF, web
        // Cmd+P) paginates the whole document instead of one viewport.
        // TocStoreProvider scopes one outline store to this editor (trigger
        // button, TocController, TocPanel); SearchStoreProvider scopes one
        // find/replace store (FindBar in the scroll container, FindMenuItem
        // in the ⋯ menu — the menu entry IS the keyboard shortcut). Both are
        // context only, no DOM wrapper — same posture as DOMDProvider.
        <TocStoreProvider>
        <SearchStoreProvider>
        <div className="domd-editor-shell fixed inset-0 bg-base-100 overflow-hidden">
            {/* Format shortcuts (⌘1/⌘K/⌥⌘C/…) live outside the top bar: the
                desktop build renders no web top bar, and they must work
                there too. */}
            <FormatShortcuts />
            {/* Outline engine + scroll spy; renders nothing, active only
                while the TOC panel is open. */}
            <TocController scrollAreaRef={scrollAreaRef} />
            <div
                className="domd-editor-viewport absolute inset-x-0 flex flex-col"
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
                {showSaveBar ? (
                    // z-40 makes the bar its own stacking layer above the
                    // document. Without it the bar's popovers lose: the
                    // centered cluster below is `-translate-*`, which opens a
                    // local stacking context, so a dropdown's z-index is
                    // trapped inside it — and the cluster itself is only
                    // z-auto, which the table renderer's `relative` root
                    // (later in DOM order) paints straight over.
                    <div className="relative z-40 shrink-0 h-10 flex items-center gap-2 px-3 text-xs text-base-content/50 bg-base-200 border-b border-base-content/15 select-none print:hidden">
                        <BrandMark />
                        <span
                            aria-hidden
                            className="h-3.5 w-px bg-base-content/15"
                        />
                        {/* Outline (TOC) toggle sits on the left, matching
                            the side its panel opens from. DaisyUI tooltip
                            (not a native title) so the shortcut shows on
                            hover alongside the name. */}
                        <div
                            className="tooltip tooltip-bottom"
                            data-tip={`${t("toc.title")} ${
                                mac
                                    ? TOC_TOGGLE_SHORTCUT.mac
                                    : TOC_TOGGLE_SHORTCUT.other
                            }`}
                        >
                            <SidePanelTrigger panel="toc">
                                <button
                                    className="btn btn-xs btn-soft btn-square"
                                    aria-label={t("toc.title")}
                                >
                                    <TocListIcon className="size-3.5" />
                                </button>
                            </SidePanelTrigger>
                        </div>
                        {/* "New" sits on the left next to the brand: it is a
                            document-lifecycle action, not a per-document one,
                            and the right cluster (AI / history / share / more)
                            is already crowded. */}
                        {onRequestNew ? (
                            <button
                                onClick={onRequestNew}
                                className="btn btn-xs btn-soft"
                            >
                                <PlusIcon className="size-3" />
                                {/* {t("editor.newDoc")} */}
                            </button>
                        ) : null}
                        {/* macOS Notes-style centered insert entries: absolute
                            so left brand / right actions never shove them off
                            center. Hidden on small screens — the bar has no
                            room and mobile gets the keyboard quick-input bar
                            for inserts anyway. */}
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-0.5 max-md:hidden">
                            <FormatDropdown />
                            <span
                                aria-hidden
                                className="h-3.5 w-px bg-base-content/15 mr-1.5"
                            />
                            <InsertToolbar />
                        </div>
                        <span className="flex-1" />
                        {aiAvailable ? (
                            <SidePanelTrigger panel="ai">
                                {/* text-ai tints label + icon only while AI
                                    collaboration is actually on (enabled
                                    with at least one agent) — the tint is a
                                    status light, not decoration. */}
                                <button
                                    className={`btn btn-xs btn-soft gap-1${
                                        aiActive ? " text-ai" : ""
                                    }`}
                                    title={t("ai.title")}
                                >
                                    <SparklesIcon className="size-3.5" />
                                    {t("ai.button")}
                                </button>
                            </SidePanelTrigger>
                        ) : null}
                        {versioningAvailable ? (
                            <SidePanelTrigger panel="versioning">
                                <button
                                    className="btn btn-xs btn-soft gap-1"
                                    title={t("versioning.title")}
                                >
                                    <HistoryIcon className="size-3.5" />
                                    {/* Online headcount (peers + self) lives
                                    here: the panel this opens is where people
                                    are listed. The share button only breathes.
                                    Present without a live room too — the
                                    local AI session has collaborators (you
                                    + agents), history and restore. */}
                                    {` · ${collabPeerCount + 1}`}
                                </button>
                            </SidePanelTrigger>
                        ) : null}
                        {onRequestShare ? (
                            <button
                                onClick={onRequestShare}
                                className={
                                    collabActive
                                        ? "btn btn-xs gap-1.5 ml-1 btn-soft "
                                        : "btn btn-xs gap-1.5 ml-1 btn-soft"
                                }
                            >
                                {collabActive ? (
                                    <>
                                        <span className="inline-block size-1.5 rounded-full bg-current animate-pulse" />
                                        {t("collab.sharingBadge")}
                                    </>
                                ) : (
                                    <>
                                        <UsersIcon className="size-3.5 " />
                                        {/* {t("collab.share")} */}
                                    </>
                                )}
                            </button>
                        ) : null}
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
                                {/* Display-mode switch: a fixed label plus a
                                    toggle whose position IS the current state
                                    (on = markdown, off = rich) — an action
                                    label naming the target mode read as
                                    ambiguous. Same toggleEditorMode call as
                                    the Cmd+/ keystroke (see ModeController).
                                    No blur: the menu stays open so the mode
                                    change is visible behind it. */}
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
                                                if (store)
                                                    toggleEditorMode(
                                                        store,
                                                        mode,
                                                    );
                                            }}
                                        />
                                    </label>
                                </li>
                                {/* Find & replace: the only entry point on
                                    touch devices (no ⌘F). Shares the
                                    SearchStore with FindBar through the
                                    provider — literally the same openFind()
                                    call the keyboard shortcut makes. */}
                                {isEditable ? <FindMenuItem /> : null}
                                <li>
                                    <button
                                        onClick={(e) => {
                                            e.currentTarget.blur();
                                            onRequestOpenUrl();
                                        }}
                                    >
                                        {t("editor.openUrl")}
                                    </button>
                                </li>
                                <li>
                                    <button
                                        disabled={saving}
                                        onClick={(e) => {
                                            e.currentTarget.blur();
                                            void doSave(renderData);
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
                                                domdRef.current,
                                                getTitle() || meta.name,
                                            );
                                        }}
                                    >
                                        {t("editor.exportPdf")}
                                    </button>
                                </li>
                            </ul>
                        </div>
                    </div>
                ) : null}

                <SidePanelHost
                    id="editor-side-panel"
                    panel={sidePanel}
                    side={sidePanelSide}
                >
                    <div
                        ref={scrollAreaRef}
                        className="domd-editor-scroll flex-1 min-h-0 overflow-y-auto"
                        onClick={(e) => {
                            if (domdRef.current?.contains(e.target as Node))
                                return;
                            store?.focus();
                        }}
                    >
                        {/* Find & replace widget: a zero-height sticky layer
                            inside the scroll container, so it pins to the top
                            of the document column and tracks its width when
                            the side panel squeezes it. Works on desktop too —
                            no dependency on the web top bar. */}
                        {isEditable ? <FindBar /> : null}
                        <div className="max-w-3xl mx-auto px-6 py-8">
                            <div ref={domdRef}>
                                <DOMD />
                                {isEditable && <CustomCursor />}
                            </div>
                        </div>
                    </div>
                </SidePanelHost>

                <QuickInputBar pin={keyboardPin} />
            </div>
        </div>
        </SearchStoreProvider>
        </TocStoreProvider>
    );
}
