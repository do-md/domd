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
    useEditor,
    useRenderData,
    useEditorStoreApi,
} from "@do-md/react";
import "@do-md/react/style.css";
import { getGrammarVersion, subscribeGrammarLoad } from "@/common/lib/prism";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";
import { useAutoSave } from "../hooks/use-auto-save";
import { useTauriEvent } from "../hooks/use-tauri-event";
import type { LocalFileEntry } from "../lib/local-files";
import { saveDocument } from "../lib/save-document";
import type { FileMeta } from "../lib/types";

export function Editor({
    meta,
    onMetaUpdate,
    onRequestOpenUrl,
    saveRef,
    localFiles,
    localFilesLoading,
    localFilesError,
    localOpenError,
    localRoot,
    sidebarOpen,
    onToggleSidebar,
    onReloadLocalFiles,
    onOpenLocalFile,
    showLocalFiles,
}: {
    meta: FileMeta;
    onMetaUpdate: (meta: FileMeta) => void;
    onRequestOpenUrl: () => void;
    saveRef: React.MutableRefObject<(() => Promise<boolean>) | null>;
    localFiles: LocalFileEntry[];
    localFilesLoading: boolean;
    localFilesError: string | null;
    localOpenError: string | null;
    localRoot: string | null;
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    onReloadLocalFiles: () => void;
    onOpenLocalFile: (path: string) => void;
    showLocalFiles: boolean;
}) {
    const renderData = useRenderData();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const editor = useEditor();
    const store = useEditorStoreApi();

    const metaRef = useLatest(meta);
    const domdRef = useRef<HTMLDivElement>(null);

    // useEffect(() => {
    //     if (editor?.aiInsertInCursor) {
    //         // @ts-ignore
    //         window.aiInsertInCursor = (text: string) => {
    //             editor?.aiInsertInCursor(text);
    //         };
    //         // @ts-ignore
    //         window.insertText = (text: string) => {
    //             store?.insertText(text);
    //         };
    //         // @ts-ignore
    //         window.insertTexts = async (...texts: string) => {
    //             const SPEED = 1.0;

    //             const sleep = (ms: number) =>
    //                 new Promise((r) => setTimeout(r, ms * SPEED));
    //             const rand = (min: number, max: number) =>
    //                 min + Math.random() * (max - min);

    //             for (const chunk of texts) {
    //                 store.insertText(chunk);
    //                 await sleep(rand(25, 60));
    //             }
    //         };
    //         // @ts-ignore
    //         window.mockAI = async (text: string) => {
    //             const SPEED = 1.0;

    //             const content = text;

    //             const sleep = (ms: number) =>
    //                 new Promise((r) => setTimeout(r, ms * SPEED));
    //             const rand = (min: number, max: number) =>
    //                 min + Math.random() * (max - min);

    //             let i = 0;
    //             while (i < content.length) {
    //                 const chunkSize = 1 + Math.floor(Math.random() * 5); // 1..5
    //                 const chunk = content.slice(i, i + chunkSize);
    //                 store.insertText(chunk);
    //                 i += chunkSize;

    //                 await sleep(rand(25, 60));
    //             }
    //         };
    //     }
    // }, [editor, store]);

    // Benchmark: signal once after the initial paint. initMd makes renderData
    // available synchronously on first render, so a single mount effect is enough.
    useEffect(() => {
        if (!isTauri()) return;
        const raf1 = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                tauriCore().then(({ invoke }) => {
                    invoke("benchmark_mark_ready").catch(() => {});
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
                if (
                    currentMeta.kind === "web" ||
                    currentMeta.kind === "server"
                ) {
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
        if (!editor) return;
        const id = setTimeout(() => {
            const md = toMarkdown(renderDataRef.current) ?? "";
            editor.editorStore.resetMD(md);
        }, 50);
        return () => clearTimeout(id);
    }, [grammarVersion, editor]);

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
        if (isEmpty && editor?.editorStore) {
            editor.editorStore.resetMD(text);
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
                    invoke("update_selection", { sel }).catch(() => {});
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
                    () => {},
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
            }).catch(() => {});
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

    // Web: warn before unload if there's no file handle yet. Listener attaches
    // once on mount; reads the latest meta via ref so updates don't rebind it.
    useEffect(() => {
        if (isTauri()) return;
        const handler = (e: BeforeUnloadEvent) => {
            const m = metaRef.current;
            if (m.kind === "web" && !m.handle) {
                e.preventDefault();
            }
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [metaRef]);

    const showSaveBar = meta.kind !== "tauri";
    const activeLocalPath = meta.kind === "server" ? meta.path : null;

    return (
        <div className="fixed inset-0 flex bg-base-100 overflow-hidden">
            {showLocalFiles && sidebarOpen ? (
                <button
                    aria-label="Close file list"
                    onClick={onToggleSidebar}
                    className="fixed inset-0 z-20 bg-black/30 md:hidden"
                />
            ) : null}
            {showLocalFiles ? (
                <aside
                    className={`z-30 flex h-full flex-col bg-base-200 transition-all duration-200 overflow-hidden ${
                        sidebarOpen
                            ? "w-72 md:w-64 translate-x-0 border-r border-base-300"
                            : "w-0 -translate-x-full border-r-0"
                    } fixed md:relative`}
                >
                    <div className="shrink-0 h-9 flex items-center justify-between px-3 text-xs font-medium text-base-content/70 border-b border-base-300">
                        <span className="truncate">Local files</span>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={onReloadLocalFiles}
                                className="btn btn-xs btn-ghost"
                            >
                                Reload
                            </button>
                            <button
                                onClick={onToggleSidebar}
                                className="btn btn-xs btn-ghost"
                            >
                                Hide
                            </button>
                        </div>
                    </div>
                    <div className="px-3 py-2 text-[11px] text-base-content/50 border-b border-base-300 truncate">
                        {localRoot ?? "Folder unavailable"}
                    </div>
                    {localOpenError ? (
                        <div className="px-3 py-2 text-[11px] text-error border-b border-base-300">
                            {localOpenError}
                        </div>
                    ) : null}
                    <div className="flex-1 overflow-y-auto">
                        {localFilesLoading ? (
                            <div className="px-3 py-3 text-xs text-base-content/60">
                                Loading files...
                            </div>
                        ) : localFilesError ? (
                            <div className="px-3 py-3 text-xs text-error">
                                {localFilesError}
                            </div>
                        ) : localFiles.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-base-content/60">
                                No markdown files found.
                            </div>
                        ) : (
                            <ul className="py-2">
                                {localFiles.map((file) => {
                                    const isActive =
                                        activeLocalPath === file.path;
                                    return (
                                        <li key={file.path}>
                                            <button
                                                onClick={() =>
                                                    onOpenLocalFile(file.path)
                                                }
                                                className={`w-full px-3 py-2 text-left text-xs hover:bg-base-300/60 ${
                                                    isActive
                                                        ? "bg-base-300/80 font-medium"
                                                        : ""
                                                }`}
                                            >
                                                <div className="truncate">
                                                    {file.name}
                                                </div>
                                                <div className="truncate text-[10px] text-base-content/50">
                                                    {file.path}
                                                </div>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </aside>
            ) : null}

            <div className="flex-1 flex flex-col overflow-hidden">
                {showSaveBar ? (
                    <div className="shrink-0 h-9 flex items-center gap-2 px-3 text-xs text-base-content/50 bg-base-200 border-b border-base-300 select-none">
                        {showLocalFiles ? (
                            <button
                                onClick={onToggleSidebar}
                                className="btn btn-xs btn-ghost"
                            >
                                {sidebarOpen ? "Hide files" : "Files"}
                            </button>
                        ) : null}
                        <span className="truncate flex-1">{meta.name}</span>
                        <button
                            onClick={onRequestOpenUrl}
                            className="btn btn-xs btn-ghost"
                        >
                            Open URL...
                        </button>
                        <button
                            onClick={() => doSave(renderData)}
                            disabled={saving}
                            className="btn btn-xs btn-neutral"
                        >
                            {saving ? "Saving..." : saved ? "Saved" : "Save"}
                        </button>
                    </div>
                ) : null}

                <div
                    className="flex-1 overflow-y-auto"
                    onClick={(e) => {
                        if (domdRef.current?.contains(e.target as Node))
                            return;
                        editor?.focus();
                    }}
                >
                    <div className="max-w-3xl mx-auto px-6 py-8">
                        <div ref={domdRef}>
                            <DOMD />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
