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
    useEditorStore,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { useTranslation } from "react-i18next";
import { getGrammarVersion, subscribeGrammarLoad } from "@/common/lib/prism";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";
import { useAutoSave } from "../hooks/use-auto-save";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { saveDocument } from "../lib/save-document";
import type { FileMeta } from "../lib/types";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";

export function Editor({
    meta,
    onMetaUpdate,
    onRequestOpenUrl,
    saveRef,
}: {
    meta: FileMeta;
    onMetaUpdate: (meta: FileMeta) => void;
    onRequestOpenUrl: () => void;
    saveRef: React.MutableRefObject<(() => Promise<boolean>) | null>;
}) {
    const { t } = useTranslation();
    const renderData = useRenderData();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const editor = useEditor();
    const store = useEditorStoreApi();
    const isEditable = useEditorStore((store) => store.isEditable);

    const metaRef = useLatest(meta);
    const domdRef = useRef<HTMLDivElement>(null);

    // Auto-focus once when the editor instance materializes. @do-md hands the
    // editor back via a deferred setTimeout in its provider, so the first
    // render sees `editor === null` — a plain mount effect would no-op. The
    // ref keeps focus from re-firing later (e.g. after user has clicked
    // elsewhere or another doc swap re-runs this effect).
    const didFocusRef = useRef(false);
    useEffect(() => {
        if (!editor || didFocusRef.current) return;
        didFocusRef.current = true;
        editor.focus?.();
    }, [editor]);

    useEffect(() => {
        // @ts-expect-error
        window.toMarkdown = () => {
            return toMarkdown(renderData);
        };
    }, [store, renderData]);

    useEffect(() => {
        if (editor?.aiInsertInCursor) {
            // @ts-expect-error
            window.aiInsertInCursor = (text: string) => {
                editor?.aiInsertInCursor(text);
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
    }, [editor, store]);

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

    const showSaveBar = meta.kind === "web";

    return (
        <div className="fixed inset-0 flex flex-col bg-base-100 overflow-hidden">
            {showSaveBar ? (
                <div className="shrink-0 h-9 flex items-center gap-2 px-3 text-xs text-base-content/50 bg-base-200 border-b border-base-300 select-none">
                    <span className="truncate flex-1">{meta.name}</span>
                    <button
                        onClick={onRequestOpenUrl}
                        className="btn btn-xs btn-ghost"
                    >
                        {t("editor.openUrl")}
                    </button>
                    <button
                        onClick={() => doSave(renderData)}
                        disabled={saving}
                        className="btn btn-xs btn-neutral"
                    >
                        {saving ? t("editor.saving") : saved ? t("editor.saved") : t("editor.save")}
                    </button>
                </div>
            ) : null}

            <div
                className="flex-1 overflow-y-auto"
                onClick={(e) => {
                    if (domdRef.current?.contains(e.target as Node)) return;
                    editor?.focus();
                }}
            >
                <div className="max-w-3xl mx-auto px-6 py-8">
                    <div ref={domdRef}>
                        <DOMD />
                        {isEditable &&  <CustomCursor />}
                    </div>
                </div>
            </div>
        </div>
    );
}
