import { useEffect, useRef, useState } from "react";
import {
    EditorContext,
    EditorDomContext,
    EditorRenderComponentContext,
} from "../context";
import Renderer from "./Renderer";
import { UseCursor } from "../hooks/UseCursor";
import { EditorController } from "../../../controller/EditorController";
import { MarkdownType } from "../../../type/enum";
import {
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

const EditorProvider = ({ children }: { children: React.ReactNode }) => {
    const textAreaDomRef = useRef<HTMLDivElement>(null);
    const [editor, setEditor] = useState<EditorController | null>(null);

    const editorStore = useEditorStoreApi();
    // Focus intent -> real DOM focus. store.focus() only bumps focusRequest_ (it
    // touches no DOM); turning that intent into an actual focus call happens here,
    // so the host only ever talks to the store and never needs the editor instance.
    const focusRequest = useEditorStore((store) => store.focusRequest_);

    useEffect(() => {
        let editorController: EditorController;
        if (textAreaDomRef.current) {
            editorController = new EditorController({
                textAreaDom: textAreaDomRef.current,
                editorStore: editorStore,
            })
            editorController.init_();
            setEditor(editorController);
        }

        return () => {
            editorController?.destroy_();
        }
    }, [editorStore]);

    // The initial value 0 means nobody has requested focus yet, so skip it; every
    // later focus() bump lands here.
    useEffect(() => {
        if (!focusRequest || !editor) return;
        editor.focus();
    }, [focusRequest, editor]);

    return (
        <EditorDomContext.Provider value={{ textAreaDomRef }}>
            <EditorContext.Provider value={editor}>
                {children}
            </EditorContext.Provider>
        </EditorDomContext.Provider>
    );
};

export const DOMDProvider = ({
    children,
    editable = true,
    initMd,
    placeholder = "",
    mode = "markdown",
    renderComponent = {},
    codeTokenizer,
    codeBeautify,
    htmlTokenizer,
    inlineRules,
    imgGroupSeparators,
    imageLoader,
    newlineKey,
    onEnter,
}: {
    children: React.ReactNode;
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
    codeTokenizer?: (code: string, lang?: string) => (string | Token)[];
    htmlTokenizer?: (html: string) => Token[];
    codeBeautify?: (code: string, lang?: string) => string | undefined;
    /** Declarative inline syntax rules. Default = defaultInlineRules (the
     *  `==` highlight); passing a value replaces the whole set (spread
     *  defaultInlineRules to keep `==`). */
    inlineRules?: InlineRule[];
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
            initialProps={{
                editable: editable,
                initMd,
                placeholder,
                mode,
                codeTokenizer,
                codeBeautify,
                htmlTokenizer,
                inlineRules,
                imgGroupSeparators,
                imageLoader,
                newlineKey,
                onEnter,
            }}
        >
            <EditorRenderComponentContext.Provider value={renderComponent}>
                <EditorProvider>{children}</EditorProvider>
            </EditorRenderComponentContext.Provider>
        </EditorStoreProvider>
    );
};

export const DOMD = () => {
    const renderData = useEditorStore((store) => store.renderData_);
    const isEditable = useEditorStore((store) => store.isEditable);
    return (
        <div>
            {isEditable && <UseCursor />}
            <Renderer parsedData={renderData} />
        </div>
    );
};

DOMD.displayName = "DOMD";
