"use client";
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import {
    DOMD,
    DOMDProvider,
    toMarkdown,
    useEditor,
    useEditorStoreApi,
    useRenderData,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";

type EditorStore = NonNullable<ReturnType<typeof useEditorStoreApi>>;

export type DomdChatInputHandle = {
    setMarkdown: (md: string) => void;
};

type Props = {
    onSubmit: (markdown: string) => void;
    disabled: boolean;
};

const PLACEHOLDER =
    "Write with Markdown... Enter to send, Shift+Enter for newline";

// Inner surface — lives *inside* the DOMD provider so it can read the store.
// Handles seeding/focus, draft sync (for remount preservation), the empty
// check that disables Send, and the toolbar (expand toggle + Send button).
function InputInner({
    expanded,
    onToggleExpand,
    disabled,
    draftRef,
    storeRef,
    editorRef,
    submitFromStore,
}: {
    expanded: boolean;
    onToggleExpand: () => void;
    disabled: boolean;
    draftRef: React.MutableRefObject<string>;
    storeRef: React.MutableRefObject<EditorStore | null>;
    editorRef: React.MutableRefObject<ReturnType<typeof useEditor>>;
    submitFromStore: (store: EditorStore) => boolean;
}) {
    const store = useEditorStoreApi();
    const editor = useEditor();
    const renderData = useRenderData();

    const markdown = toMarkdown(renderData) ?? "";
    const isEmpty = markdown.trim().length === 0;

    // Expose store/editor to the parent for imperative setMarkdown / focus.
    useEffect(() => {
        storeRef.current = store;
    }, [store, storeRef]);
    useEffect(() => {
        editorRef.current = editor;
    }, [editor, editorRef]);

    // Keep the draft in sync so an expand/collapse remount restores content.
    useEffect(() => {
        draftRef.current = markdown;
    }, [markdown, draftRef]);

    // Seed the empty doc once so it has a cursor (an unseeded DOMD doc has no
    // caret and rejects typing/programmatic inserts). Skip when content was
    // restored from the draft on a mode switch.
    const didSeed = useRef(false);
    useEffect(() => {
        if (!store || didSeed.current) return;
        didSeed.current = true;
        if (!draftRef.current) store.resetMD("");
    }, [store, draftRef]);

    // Focus once when the editor instance materializes (the provider hands it
    // back via a deferred setTimeout, so the first render sees null).
    const didFocus = useRef(false);
    useEffect(() => {
        if (!editor || didFocus.current) return;
        didFocus.current = true;
        editor.focus?.();
    }, [editor]);

    const send = () => {
        if (!store) return;
        if (submitFromStore(store)) editor?.focus?.();
    };

    const sendDisabled = disabled || isEmpty;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-2 pt-1.5">
                <span className="text-[11px] text-base-content/40 pl-1 select-none">
                    {expanded ? "Expanded" : "Markdown"}
                </span>
                <button
                    type="button"
                    onClick={onToggleExpand}
                    className="btn btn-ghost btn-xs btn-circle text-base-content/50"
                    aria-label={expanded ? "Collapse input" : "Expand input"}
                    title={expanded ? "Collapse (Esc)" : "Expand"}
                >
                    {expanded ? (
                        // collapse: four arrows pointing inward (toward center)
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="w-4 h-4"
                        >
                            <path d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                        </svg>
                    ) : (
                        // expand: four arrows pointing outward (to corners)
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="w-4 h-4"
                        >
                            <path d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M20.25 20.25v-4.5m0 4.5h-4.5m4.5 0L15 15" />
                        </svg>
                    )}
                </button>
            </div>

            <div
                className={`flex-1 min-h-0 overflow-y-auto px-3 pb-2 ${
                    expanded ? "" : "max-h-44"
                }`}
            >
                <DOMD />
                <CustomCursor />
            </div>

            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-base-300">
                <span className="text-[11px] text-base-content/40 select-none truncate">
                    {expanded ? (
                        <>
                            <kbd className="kbd kbd-xs">Enter</kbd> newline ·{" "}
                            <kbd className="kbd kbd-xs">Esc</kbd> collapse
                        </>
                    ) : (
                        <>
                            <kbd className="kbd kbd-xs">Enter</kbd> send ·{" "}
                            <kbd className="kbd kbd-xs">⇧ Enter</kbd> newline
                        </>
                    )}
                </span>
                <button
                    type="button"
                    onClick={send}
                    disabled={sendDisabled}
                    className="btn btn-accent btn-sm"
                >
                    Send
                </button>
            </div>
        </div>
    );
}

/**
 * Markdown-native chat input.
 *
 * Two modes, swapped by remounting the provider (the Enter contract is fixed at
 * construction time, so a remount is how we switch it):
 *  - compact: `newlineKey="Shift+Enter"` + `onEnter` → Enter submits.
 *  - expanded: no newlineKey/onEnter → default editor, Enter inserts a newline;
 *    you submit with the button. Esc collapses back.
 *
 * Content survives the remount via `draftRef` (kept current by InputInner).
 */
export const DomdChatInput = forwardRef<DomdChatInputHandle, Props>(
    function DomdChatInput({ onSubmit, disabled }, ref) {
        const [expanded, setExpanded] = useState(false);
        // initMd is consumed only at provider mount; we snapshot the live draft
        // into it at the moment of an expand/collapse toggle (in the event
        // handler, never read from a ref during render).
        const [initialMd, setInitialMd] = useState("");
        // Bumped on every send to remount the provider — a fresh editor is the
        // cleanest reset (caret, pending text, composition state all start
        // clean), more reliable than resetMD("") on the existing instance.
        const [gen, setGen] = useState(0);
        const draftRef = useRef("");
        const storeRef = useRef<EditorStore | null>(null);
        const editorRef = useRef<ReturnType<typeof useEditor>>(null);

        // Route through refs so the construction-time onEnter closure always
        // sees the latest props (it's captured once at provider mount). Written
        // in effects, not during render, so they stay current for the next
        // keydown without violating the refs-during-render rule.
        const onSubmitRef = useRef(onSubmit);
        const disabledRef = useRef(disabled);
        useEffect(() => {
            onSubmitRef.current = onSubmit;
        });
        useEffect(() => {
            disabledRef.current = disabled;
        });

        const submitFromStore = useCallback((store: EditorStore) => {
            if (disabledRef.current) return false;
            const md = store.toMarkdown();
            if (!md.trim()) return false;
            onSubmitRef.current(md);
            // Reset by remounting a fresh editor instead of mutating this one.
            draftRef.current = "";
            setInitialMd("");
            setGen((g) => g + 1);
            return true;
        }, []);

        useImperativeHandle(
            ref,
            () => ({
                setMarkdown: (md: string) => {
                    draftRef.current = md;
                    storeRef.current?.resetMD(md);
                    editorRef.current?.focus?.();
                },
            }),
            [],
        );

        const toggleExpand = useCallback(() => {
            // Snapshot current content so the remounted provider restores it.
            setInitialMd(draftRef.current);
            setExpanded((v) => !v);
        }, []);

        // Esc collapses expanded mode.
        useEffect(() => {
            if (!expanded) return;
            const onKey = (e: KeyboardEvent) => {
                if (e.key === "Escape") setExpanded(false);
            };
            window.addEventListener("keydown", onKey);
            return () => window.removeEventListener("keydown", onKey);
        }, [expanded]);

        const providerNode = (
            <DOMDProvider
                key={`${expanded ? "expanded" : "compact"}-${gen}`}
                editable={true}
                initMd={initialMd}
                placeholder={PLACEHOLDER}
                codeTokenizer={tokenize}
                newlineKey={expanded ? undefined : "Shift+Enter"}
                onEnter={expanded ? undefined : submitFromStore}
            >
                <InputInner
                    expanded={expanded}
                    onToggleExpand={toggleExpand}
                    disabled={disabled}
                    draftRef={draftRef}
                    storeRef={storeRef}
                    editorRef={editorRef}
                    submitFromStore={submitFromStore}
                />
            </DOMDProvider>
        );

        if (expanded) {
            return (
                <div
                    className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setExpanded(false);
                    }}
                >
                    <div className="w-full max-w-3xl h-[70vh] flex flex-col rounded-2xl border border-base-300 bg-base-100 shadow-xl overflow-hidden">
                        {providerNode}
                    </div>
                </div>
            );
        }

        return (
            <div className="rounded-2xl border border-base-300 bg-base-100 shadow-sm overflow-hidden focus-within:border-accent transition-colors">
                {providerNode}
            </div>
        );
    },
);
