"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { DOMD, DOMDProvider, useEditor, useEditorStoreApi } from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import { beautify } from "@/common/lib/beautify";
import { SAMPLE_DOCS, resolveDocContent } from "../lib/sample-docs";
import {
    CHUNK_BOUND_DEFAULT,
    CHUNK_BOUND_HARD_MAX,
    CHUNK_DEFAULT_MAX,
    CHUNK_DEFAULT_MIN,
    CHUNK_MIN_BOUND,
    type SpeedPreset,
    type StreamStatus,
} from "../lib/types";
import { ControlPanel } from "./control-panel";
import { StreamDriver, type StreamMetrics } from "./stream-driver";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";

const EMPTY_METRICS: StreamMetrics = { chars: 0, chunks: 0, elapsedMs: 0 };

const DROPPED_DOC_ID = "__dropped__";
const MAX_DROPPED_BYTES = 10 * 1024 * 1024; // 10 MB — sanity cap on dropped files

// Seeds the freshly-mounted provider so the empty doc has a usable cursor
// (an unseeded DOMD doc rejects programmatic insertText, and human focus
// behaves better with an initialized structure). Runs exactly once per
// provider mount — never reseeds when `skipSeed` flips back to false, since
// that would wipe streamed content the moment a run finishes.
function EditorInit({ skipSeed }: { skipSeed: boolean }) {
    const store = useEditorStoreApi();
    const editor = useEditor();
    const didSeedRef = useRef(false);
    const didFocusRef = useRef(false);

    // Seed runs once when the store is ready. Mark as done even when we skip
    // (stream-driven mount) so a later skipSeed flip back to false doesn't
    // wipe the streamed content.
    useEffect(() => {
        if (!store || didSeedRef.current) return;
        didSeedRef.current = true;
        if (skipSeed) return;
        store.resetMD("");
    }, [store, skipSeed]);

    // Focus runs once when the editor instance is actually available — the
    // DOMD provider hands it back via a setTimeout, so the very first render
    // sees `editor === null`. Skipping the focus call (or guarding it with the
    // same ref as seed) used to leave the doc unfocused, blocking typing.
    useEffect(() => {
        if (!editor || didFocusRef.current) return;
        didFocusRef.current = true;
        if (skipSeed) return;
        editor.focus?.();
    }, [editor, skipSeed]);
    return null;
}

export function PlaygroundApp() {
    const { t } = useTranslation();
    const [docId, setDocId] = useState(SAMPLE_DOCS[0].id);
    const [chunkBound, setChunkBound] = useState<number>(CHUNK_BOUND_DEFAULT);
    const [minChunk, setMinChunk] = useState<number>(CHUNK_DEFAULT_MIN);
    const [maxChunk, setMaxChunk] = useState<number>(CHUNK_DEFAULT_MAX);
    const [speed, setSpeed] = useState<SpeedPreset>("normal");

    const setChunkRange = useCallback((lo: number, hi: number) => {
        setMinChunk(lo);
        setMaxChunk(hi);
    }, []);

    const setChunkBoundClamped = useCallback((n: number) => {
        const next = Math.max(
            CHUNK_MIN_BOUND,
            Math.min(CHUNK_BOUND_HARD_MAX, Math.floor(n)),
        );
        setChunkBound(next);
        // If the bound shrinks below the current range, clamp the range too.
        setMaxChunk((m) => Math.min(m, next));
        setMinChunk((m) => Math.min(m, next));
    }, []);

    // runId !== 0 means "a stream is requested with this exact text".
    // Bumping runId starts a new stream. providerKey remounts the editor so
    // we get a clean empty document.
    const [runId, setRunId] = useState(0);
    const [providerKey, setProviderKey] = useState(0);
    const [streamText, setStreamText] = useState("");

    const [status, setStatus] = useState<StreamStatus>("idle");
    const [metrics, setMetrics] = useState<StreamMetrics>(EMPTY_METRICS);

    const [mobileOpen, setMobileOpen] = useState(false);
    // Mobile users land with the settings modal open so they don't have to
    // hunt for it. Defer to a post-mount effect to avoid SSR/client mismatch.
    useEffect(() => {
        if (window.matchMedia("(max-width: 767px)").matches) {
            setMobileOpen(true);
        }
    }, []);
    const [dragging, setDragging] = useState(false);
    // Stays loaded across runs so users can restart the same dropped file.
    const [droppedDoc, setDroppedDoc] = useState<{
        name: string;
        text: string;
    } | null>(null);

    const startWith = useCallback((text: string) => {
        setStreamText(text);
        setMetrics(EMPTY_METRICS);
        setStatus("streaming");
        // Remount the editor first to ensure a clean doc, then trigger a new run.
        setProviderKey((k) => k + 1);
        setRunId((r) => r + 1);
    }, []);

    const start = useCallback(() => {
        if (docId === DROPPED_DOC_ID && droppedDoc) {
            startWith(droppedDoc.text);
            return;
        }
        const doc = SAMPLE_DOCS.find((d) => d.id === docId) ?? SAMPLE_DOCS[0];
        startWith(resolveDocContent(doc));
    }, [docId, droppedDoc, startWith]);

    const stop = useCallback(() => {
        // Unmount the driver — its cleanup flips `cancelled` and the loop exits.
        setRunId(0);
        setStatus((s) => (s === "streaming" ? "stopped" : s));
    }, []);

    const clear = useCallback(() => {
        setRunId(0);
        setStreamText("");
        setMetrics(EMPTY_METRICS);
        setStatus("idle");
        setProviderKey((k) => k + 1);
    }, []);

    const onDone = useCallback(() => {
        setStatus("done");
        setRunId(0);
    }, []);

    const handleFile = useCallback(
        async (file: File) => {
            if (file.size > MAX_DROPPED_BYTES) return;
            let text: string;
            try {
                text = await file.text();
            } catch {
                return;
            }
            setDroppedDoc({ name: file.name, text });
            setDocId(DROPPED_DOC_ID);
            startWith(text);
        },
        [startWith],
    );

    const dragHandlers = useMemo(
        () => ({
            onDragOver: (e: React.DragEvent) => {
                if (!Array.from(e.dataTransfer?.types ?? []).includes("Files"))
                    return;
                e.preventDefault();
                setDragging(true);
            },
            onDragLeave: (e: React.DragEvent) => {
                // only clear when the cursor actually leaves the wrapper
                if (e.currentTarget === e.target) setDragging(false);
            },
            onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer?.files?.[0];
                if (file) handleFile(file);
            },
        }),
        [handleFile],
    );

    const controlProps = useMemo(
        () => ({
            docId,
            onDocChange: setDocId,
            droppedDoc,
            droppedDocId: DROPPED_DOC_ID,
            chunkBound,
            onChunkBoundChange: setChunkBoundClamped,
            minChunk,
            maxChunk,
            onChunkRangeChange: setChunkRange,
            speed,
            onSpeedChange: setSpeed,
            status,
            metrics,
            onStart: start,
            onStop: stop,
            onClear: clear,
        }),
        [
            docId,
            droppedDoc,
            chunkBound,
            setChunkBoundClamped,
            minChunk,
            maxChunk,
            setChunkRange,
            speed,
            status,
            metrics,
            start,
            stop,
            clear,
        ],
    );

    return (
        <div className="fixed inset-0 flex flex-col bg-base-100 text-base-content overflow-hidden">
            <header className="shrink-0 h-12 flex items-center justify-between px-3 md:px-4 bg-base-200 border-b border-base-300">
                <div className="flex items-center gap-2 min-w-0">
                    <Link
                        href="/"
                        className="btn btn-ghost btn-xs"
                        aria-label={t("common.home")}
                    >
                        ←
                    </Link>
                    <span className="font-semibold text-sm truncate">
                        {t("playground.headerTitle")}
                    </span>
                    <span className="hidden sm:inline text-xs text-base-content/50 truncate">
                        {t("playground.headerSubtitle")}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setMobileOpen(true)}
                        className="btn btn-xs btn-neutral md:hidden"
                    >
                        {t("playground.settings")}
                    </button>
                    <a
                        href="https://github.com/do-md/domd"
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={t("common.github")}
                        className="btn btn-ghost btn-circle"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            className="w-8 h-8"
                        >
                            <path
                                fillRule="evenodd"
                                clipRule="evenodd"
                                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.683-.217.683-.483 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
                            />
                        </svg>
                    </a>
                </div>
            </header>

            <div className="flex-1 flex min-h-0">
                {/* Desktop sidebar */}
                <aside className="hidden md:flex w-80 shrink-0 border-r border-base-300 bg-base-200/50">
                    <ControlPanel {...controlProps} />
                </aside>

                {/* Editor area */}
                <main
                    className="flex-1 min-w-0 overflow-y-auto relative"
                    onDragOver={dragHandlers.onDragOver}
                    onDragLeave={dragHandlers.onDragLeave}
                    onDrop={dragHandlers.onDrop}
                >
                    {dragging ? (
                        <div className="absolute inset-0 z-30 flex items-center justify-center bg-accent/90 pointer-events-none">
                            <div className="text-lg font-medium text-accent-content">
                                {t("playground.dropToStream")}
                            </div>
                        </div>
                    ) : null}
                    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
                        <div
                            style={
                                status === "streaming"
                                    ? {
                                          pointerEvents: "none",
                                          userSelect: "none",
                                      }
                                    : undefined
                            }
                        >
                            <DOMDProvider
                                key={providerKey}
                                editable={true}
                                initMd=""
                                placeholder={t("playground.placeholder")}
                                codeTokenizer={tokenize}
                                codeBeautify={beautify}
                            >
                                <EditorInit skipSeed={runId > 0} />
                                <DOMD />
                                <CustomCursor />
                                <StreamDriver
                                    runId={runId}
                                    text={streamText}
                                    minChunk={minChunk}
                                    maxChunk={maxChunk}
                                    speed={speed}
                                    onProgress={setMetrics}
                                    onDone={onDone}
                                />
                            </DOMDProvider>
                        </div>
                    </div>
                </main>
            </div>

            {/* Mobile modal */}
            <dialog
                className={`modal ${mobileOpen ? "modal-open" : ""} md:hidden`}
            >
                <div className="modal-box max-w-md w-[92%] p-0 max-h-[80vh] flex flex-col overflow-hidden">
                    <ControlPanel
                        {...controlProps}
                        onApply={() => setMobileOpen(false)}
                    />
                    <div className="shrink-0 px-5 py-2 border-t border-base-300 flex justify-end">
                        <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setMobileOpen(false)}
                        >
                            {t("playground.close")}
                        </button>
                    </div>
                </div>
                <form
                    method="dialog"
                    className="modal-backdrop"
                    onClick={() => setMobileOpen(false)}
                >
                    <button>close</button>
                </form>
            </dialog>
        </div>
    );
}
