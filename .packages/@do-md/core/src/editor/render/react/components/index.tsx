import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    EditorContext,
    EditorDomContext,
    EditorRenderComponentContext,
} from "../context";
import Renderer from "./Renderer";
import { UseCursor } from "../hooks/UseCursor";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { EditorController } from "../../../controller/EditorController";
import { MarkdownType } from "../../../type/enum";
import {
    CopyAs,
    EditorMode,
    ImageLoader,
    InlineRule,
    NewlineKey,
    ParentRenderData,
    RenderData,
    RenderElementProps,
    Token,
} from "../../../type";
import {
    useEditorStore,
    useEditorStoreApi,
    EditorStoreProvider,
    EditorStore,
} from "../../../store";

const EditorProvider = ({
    children,
    copyAs,
}: {
    children: React.ReactNode;
    copyAs: CopyAs;
}) => {
    const textAreaDomRef = useRef<HTMLDivElement>(null);
    // A view preference read at copy/cut time: the controller pulls the
    // latest committed value through a getter, so switching it never
    // rebuilds the controller (and never re-binds its listeners).
    const copyAsRef = useRef(copyAs);
    useEffect(() => {
        copyAsRef.current = copyAs;
    }, [copyAs]);
    // The editable root's DOM node mirrored into state, so its arrival and
    // departure drive the controller effect below. A plain ref cannot: React
    // never re-renders on ref writes, and this provider does NOT unmount with
    // the view — under bring-your-own-store a host detaches the render
    // subtree while the provider (and store) keep living. Keying the
    // controller to the provider's lifetime left it bound to a dead root
    // after a re-attach: the fresh contenteditable had no kernel listeners,
    // edits went through the browser's native path — visible in the DOM,
    // absent from the model, gone on the next detach.
    const [textAreaDom, setTextAreaDom] = useState<HTMLDivElement | null>(
        null,
    );
    const [editor, setEditor] = useState<EditorController | null>(null);

    const editorStore = useEditorStoreApi();
    // Focus intent -> real DOM focus. store.focus() only bumps focusRequest_ (it
    // touches no DOM); turning that intent into an actual focus call happens here,
    // so the host only ever talks to the store and never needs the editor instance.
    const focusRequest = useEditorStore((store) => store.focusRequest_);
    // Blur intent -> real DOM blur, the exact dual of focusRequest above.
    const blurRequest = useEditorStore((store) => store.blurRequest_);

    // Ref sink for the editable root: keeps the legacy ref object in sync for
    // every reader of textAreaDomRef, and feeds the state above.
    const attachTextAreaDom_ = useCallback((el: HTMLDivElement | null) => {
        textAreaDomRef.current = el;
        setTextAreaDom(el);
    }, []);

    useEffect(() => {
        if (!textAreaDom) return;
        const editorController = new EditorController({
            textAreaDom,
            editorStore: editorStore,
            getCopyAs: () => copyAsRef.current,
        });
        editorController.init_();
        setEditor(editorController);

        return () => {
            editorController.destroy_();
            // Between a detach and the next attach there is no live view;
            // dropping the instance keeps focus/blur intents from poking a
            // controller whose DOM is gone.
            setEditor(null);
        };
    }, [editorStore, textAreaDom]);

    const domContextValue = useMemo(
        () => ({ textAreaDomRef, attachTextAreaDom_ }),
        [attachTextAreaDom_],
    );

    // focusRequest_/blurRequest_ are EDGE-triggered intent counters: one bump
    // is one gesture, and each must be consumed exactly once. These effects
    // also depend on `editor` — the controller is rebuilt per attached view —
    // so without explicit dedup, every re-attach would replay the LAST
    // gesture the store ever saw (a single store.blur() would blur every
    // future attach forever, undoing the attach protocol's focus
    // restoration). The consumed-counter refs are initialized from the
    // store's CURRENT values, not 0: a store handed in with history
    // (bring-your-own-store, provider rebuilt over a live store) has all its
    // past intents already consumed by previous views — restoration is the
    // attach protocol's job (restoreViewState_), never a replayed gesture.
    const consumedFocusRef = useRef(editorStore.focusRequest_);
    const consumedBlurRef = useRef(editorStore.blurRequest_);
    useEffect(() => {
        if (!editor || focusRequest === consumedFocusRef.current) return;
        consumedFocusRef.current = focusRequest;
        editor.focus();
    }, [focusRequest, editor]);

    useEffect(() => {
        if (!editor || blurRequest === consumedBlurRef.current) return;
        consumedBlurRef.current = blurRequest;
        editor.blur();
    }, [blurRequest, editor]);

    return (
        <EditorDomContext.Provider value={domContextValue}>
            <EditorContext.Provider value={editor}>
                {children}
            </EditorContext.Provider>
        </EditorDomContext.Provider>
    );
};

export const DOMDProvider = ({
    children,
    store,
    editable = true,
    initMd,
    placeholder = "",
    mode = "markdown",
    renderComponent = {},
    copyAs = "markdown",
    codeTokenizer,
    codeBeautify,
    htmlTokenizer,
    inlineRules,
    filePaths,
    imgGroupSeparators,
    imageLoader,
    newlineKey,
    onEnter,
}: {
    children: React.ReactNode;
    /** Bring your own store: mount the editor onto an EXISTING EditorStore
     *  the host owns, instead of constructing one from the props below. When
     *  given, every construction-time prop (initMd, placeholder, mode,
     *  tokenizers, inlineRules, …) is ignored — the store already carries
     *  them. The host owns the lifecycle: the provider never destroys the
     *  store, so it survives view unmounts — the seam that turns a store
     *  into a document runtime (editor tabs: one long-lived store per tab,
     *  views attach and detach). Detach/re-attach is safe by design:
     *  EditorController.destroy_() removes listeners only and never touches
     *  store data. Captured once on mount — to switch documents, remount
     *  with a new `key` and pass the next store. */
    store?: EditorStore;
    editable?: boolean;
    initMd?: string;
    placeholder?: string;
    /** Display mode, default "markdown" (caret-adjacent symbol reveal).
     *  "rich" never reveals syntax symbols. Initial value only — hot-switch
     *  at runtime via `useEditorStoreApi().setMode(...)`. Pure view
     *  preference: model / round-trip / collaboration are unaffected. */
    mode?: EditorMode;
    /** Replace kernel default elements, keyed by MarkdownType. A replacement
     *  has the SAME single-prop signature as every kernel element
     *  (`{ parsedData }`); build it from the public kit (RenderChildren,
     *  getRenderElementProps/getSpanRenderIdProps, serializeRenderData,
     *  viewOnlyProps). View-layer only; a render throw falls back to the
     *  default element. Define the map OUTSIDE render (or useMemo). */
    renderComponent?: Partial<
        Record<MarkdownType, React.ComponentType<RenderElementProps>>
    >;
    /** What copy and cut put on the clipboard: "markdown" (default, the
     *  selection's Markdown source) or "text" (what a reader sees, no syntax
     *  symbols). A view preference like renderComponent: applies with a
     *  bring-your-own `store` too, and may change at any time. */
    copyAs?: CopyAs;
    codeTokenizer?: (code: string, lang?: string) => (string | Token)[];
    htmlTokenizer?: (html: string) => Token[];
    codeBeautify?: (code: string, lang?: string) => string | undefined;
    /** Declarative inline syntax rules. Default = defaultInlineRules (the
     *  `==` highlight); passing a value replaces the whole set (spread
     *  defaultInlineRules to keep `==`). */
    inlineRules?: InlineRule[];
    /** Opt-in lexical local-file candidates. Parsing is pure and performs no
     *  IO or resolution; override MarkdownType.FilePath to define behavior. */
    filePaths?: boolean;
    /** Opt-in image grouping: ≥2 adjacent images in one paragraph flow wrap
     *  into an ImgGroup node. Value = the SET of characters allowed between
     *  them (`""` = only touching images; `" "` = any run of spaces; `", "`
     *  = commas and/or spaces). `\n` never qualifies (soft breaks and blank
     *  lines never group). Separator text is kept verbatim inside the group
     *  — round-trip is byte-exact. Default rendering is unchanged; override
     *  via renderComponent[MarkdownType.ImgGroup]. Construction-time only;
     *  collaborative peers must share the same value. */
    imgGroupSeparators?: string;
    imageLoader?: ImageLoader;
    newlineKey?: NewlineKey;
    onEnter?: (store: EditorStore, event: KeyboardEvent) => void;
}) => {
    return (
        <EditorStoreProvider
            store={store}
            initialProps={{
                editable: editable,
                initMd,
                placeholder,
                mode,
                codeTokenizer,
                codeBeautify,
                htmlTokenizer,
                inlineRules,
                filePaths,
                imgGroupSeparators,
                imageLoader,
                newlineKey,
                onEnter,
            }}
        >
            <EditorRenderComponentContext.Provider value={renderComponent}>
                <EditorProvider copyAs={copyAs}>{children}</EditorProvider>
            </EditorRenderComponentContext.Provider>
        </EditorStoreProvider>
    );
};

export const DOMD = () => {
    const renderData = useEditorStore((store) => store.renderData_);
    const isEditable = useEditorStore((store) => store.isEditable);
    // Always-on scroll memory: reports an identity anchor (block + span uuid)
    // to the store while scrolling, and restores it once when this view
    // mounts over a store that already carries one (editor tabs, persisted
    // sessions). Lives on the view — headless stores never pay for it.
    useScrollMemory();
    return (
        <div>
            {isEditable && <UseCursor />}
            <Renderer parsedData={renderData} />
        </div>
    );
};

DOMD.displayName = "DOMD";
