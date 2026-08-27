import { ComponentType, CSSProperties, ReactNode, RefObject } from "react";
import { MarkdownType } from "./enum";
import { EditorStore } from "../store";

// Define a base Token type that can be either a string or a more complex object
export type Token =
    | string
    | {
          type: string; // Token type, such as 'keyword', 'punctuation', etc.
          content: string | Token[]; // Token content, which can be a string or an array of Tokens
          alias?: string | string[]; // Optional alias, some tokens can have one or more aliases
          length?: number; // Optional length property, some implementations may include this property
      };

export interface HtmlTagToken {
    name: string;
    type: "tag";
    attribs: Record<string, string>;
    children: (HtmlTagToken | HtmlTextToken)[];
}

export interface HtmlTextToken {
    type: "text";
    data: string;
    parent: HtmlTagToken;
}

interface BaseRenderData {
    htmlType_: MarkdownType;
    uuid_: string;
    mdSymbols_: string[];
    tagName_?: string;
    isAutoFill_?: boolean;
    /**
     * DOM remount version stamp (session-local: never serialized, never part of
     * the sync diff).
     * A span-preserving merge reuses the span references outside the changed
     * region, but during speculative rendering the browser may already have
     * written the input straight into a neighbouring span's DOM text node — the
     * model did not change → React memo and the vdom both skip it → stale text
     * is left behind (the doubled "is" in "today is" incident). On merge we bump
     * this stamp on the spans flanking the changed region: immer hands out a new
     * object and BaseElement's key carries the version → a forced remount
     * rebuilds the DOM from the model. uuid_ is untouched, so CRDT identity and
     * the op stream are unaffected.
     */
    domVersion_?: number;
    htmlProps_: {
        start?: number;
        "data-render-id"?: string;
        "data-mark"?: string;
        style?: CSSProperties;
        src?: string;
        [key: string]:
            | string
            | null
            | number
            | boolean
            | undefined
            | CSSProperties;
    };
}

export interface RenderData extends BaseRenderData {
    text_: string;
    children_?: never;
}

export interface ParentRenderData extends BaseRenderData {
    children_: (RenderData | ParentRenderData)[];
    text_?: never;
}

/** Any kernel node: a leaf (RenderData, carrying text_) or a branch
 *  (ParentRenderData, carrying children_). Treat it as an opaque value in host
 *  code — hand it straight back to the kernel's own tools (Renderer /
 *  RenderChildren / toMarkdown / getRenderElementProps / serializeRenderData)
 *  rather than branching on text_ vs children_ yourself. */
export type AnyRenderData = RenderData | ParentRenderData;

/** The single-prop signature of a kernel element, and equally the signature of a
 *  renderComponent override. The two being isomorphic is deliberate: an override
 *  looks exactly like the kernel element it replaces, and gets its capabilities by
 *  reusing the public tools instead of from a bespoke set of props per node type.
 *
 *  ```tsx
 *  const MyTable: ComponentType<RenderElementProps> = ({ parsedData }) => (
 *      <table {...getRenderElementProps(parsedData)}>
 *          <RenderChildren parsedData={parsedData} />
 *      </table>
 *  );
 *  ``` */
export interface RenderElementProps {
    parsedData: AnyRenderData;
}

export interface CursorInfo {
    uuid: string;
    offset: number;
    /**
     * Span-level anchor (optional): the uuid of the smallest text leaf holding
     * the cursor, plus the offset inside that leaf.
     * The primary coordinate (uuid + block-relative offset) drifts under
     * collaboration as soon as a peer edits the same block; a span is an
     * immutable atom that never changes uuid unless it is itself touched — so
     * re-resolving through the anchor once a remote op lands keeps the cursor
     * glued to its text. When the span IS touched (replaced wholesale) we fall
     * back to the primary coordinate.
     * The field names carry no `_` suffix: they travel across the public surface
     * with CursorSnapshot, so mangling must leave them alone.
     * See common/cursor/.
     */
    spanUuid?: string;
    /** Offset inside that leaf; always paired with spanUuid. */
    spanOffset?: number;
}

/** Toggleable inline marks driven by the format toolbar / shortcuts. */
export type InlineFormatMark =
    | "bold"
    | "italic"
    | "strike"
    | "highlight"
    | "underline";

/**
 * Per-mark slice of the reactive formatting state (the state-first
 * alternative to tiptap's command-style `isActive()` / `can()` queries).
 * - `active`: the caret sits inside this mark (collapsed cursor), or every
 *   token of the selection already carries it (range).
 * - `can`: `format(mark)` here would succeed. Range: non-empty single-block
 *   selection, a registered `==` rule for highlight, no `*`-delimiter
 *   conflict. Collapsed caret — inactive mark: can be ARMED for the next
 *   insertion (false for `*`-family marks inside another `*` construct, and
 *   in code blocks); active mark: can be toggled OFF when the caret sits at
 *   the construct tail (format() hops it outside; mid-content unformatting
 *   needs a selection).
 */
export interface MarkFormatState {
    active: boolean;
    can: boolean;
}

/** Reactive formatting state at the current cursor/selection. Derived from
 *  (cursorInfo, renderData) — never stored, never stale. Read it via
 *  `store.formatState` or the `useFormatState()` hook and bind toolbar UI
 *  (highlight/disable) directly to it. */
export type FormatState = Record<InlineFormatMark, MarkFormatState>;

/**
 * Inline format request handed to `toMarkdown` as its 3rd argument. The range
 * is the selection already carried by `cursorInfos` (start/end), so it is not
 * repeated here. `op` is resolved by the caller via tree detection before the
 * call: `add` when the selection isn't uniformly marked, `strip` otherwise.
 */
export interface InlineFormat {
    mark: InlineFormatMark;
    op: "add" | "strip";
}

/**
 * Snapshot of selection/cursor context returned by `EditorStore.getSelectionState`.
 * Field names are snake_case so the same shape can be sent over the CLI socket
 * and consumed by external agents without re-keying.
 */
export interface SelectionState {
    has_selection: boolean;
    selected_text: string;
    before: string;
    after: string;
    before_truncated: boolean;
    after_truncated: boolean;
}

export interface CompositionSnapshot {
    uuid_: string;
    text_: string;
    offset_: number;
    isPreCode_: boolean;
    preCodeUuid_?: string;
}

/**
 * Input-buffer snapshot for speculative rendering: the input layer captures it at
 * the moment of the input event (uuid / visible text / cursor offset) and pushes
 * it into store state; the flush (applyPendingText_) consumes only this snapshot,
 * so the store never reads the DOM. Same pattern as CompositionSnapshot (a
 * snapshot taken at event time), which is reserved for IME composition.
 */
export interface PendingInput {
    uuid_: string;
    text_: string;
    offset_: number;
}

export interface RootRenderData extends ParentRenderData {}

export enum CursorSource {
    Dom = 'dom',
    Model = 'model'
}

/**
 * EditorController display mode (per-user VIEW preference — never part of the document).
 * - "markdown": default WYSIWYG — syntax symbols reveal when the caret is
 *   adjacent (Typora-style).
 * - "rich": syntax symbols are NEVER revealed. The markdown source of truth,
 *   the RenderData tree and the DOM text are byte-identical to "markdown"
 *   mode; only the reveal behaviour changes. Hot-switchable via
 *   EditorStore.setMode() and excluded from undo history.
 */
export type EditorMode = "markdown" | "rich";

/**
 * Collapsed-cursor format arming (the sticky-marks input state): `format()`
 * on a collapsed caret inserts NOTHING — it arms marks for the NEXT text
 * insertion. Consumption is single-sourced in
 * `consumePendingFormatMarks_` (wrap in delimiters, caret before the
 * closes, typing flows on inside), reached from both `insertText` and the
 * IME compositionend snapshot path. No literal `****` ever appears (the
 * rich-mode requirement); markdown mode shares the same mechanism.
 * Cleared whenever the cursor leaves the anchor (any source), and on
 * compositionend when the composition didn't start at the anchor.
 */
export interface PendingFormatMarks {
    anchorUuid_: string;
    anchorOffset_: number;
    marks_: InlineFormatMark[];
}

export interface EditorState {
    /** Focus-intent counter. The store layer is DOM-free: focus() never touches
     *  document, it only increments this number; a useEffect in the render layer
     *  subscribes to it and translates the "focus" gesture into the real DOM
     *  call. It is a counter rather than a boolean because two focus() calls in a
     *  row must both take effect (a boolean would not notify subscribers, since
     *  its value never changed). */
    focusRequest_: number;
    /** Blur-intent counter — the exact dual of focusRequest_. store.blur()
     *  increments it; the render layer turns the intent into a real DOM blur
     *  on the contenteditable, so the ordinary blur chain (interaction
     *  layer, host cursor overlays) runs. Needed where the platform hides
     *  focus changes from the page (e.g. macOS WKWebView delivers no DOM
     *  blur when native chrome takes the first responder). */
    blurRequest_: number;
    paddingMdSymbols_: null | string[];
    mode_: EditorMode;
    pendingFormatMarks_: PendingFormatMarks | null;
    isEditable_: boolean;
    activeAtomicUUID_: string | null;
    pendingInput_: PendingInput | null;
    duringComposition_: boolean;
    compositionSnapshot_: CompositionSnapshot | null;
    renderUUID_: string;
    cursorInRender_: number;
    placeholder_?: string;
    cursorInfo_: {
        start_:  CursorInfo | null;
        end_:  CursorInfo | null;
        source_: CursorSource;
        /**
         * Select-all terminal state (the same shape as ProseMirror's
         * AllSelection): "the whole document" has no exact representation in the
         * (uuid, offset) coordinate space — the serialization scaffolding at the
         * edges (`#` prefixes, fences, list markers) lies outside the coordinate
         * range, and during a chunked load the not-yet-parsed part is not even in
         * the DOM. Once Cmd+A raises this flag, editing operations (delete /
         * typing / paste / cut / Enter / IME) go through the whole-document
         * primitive (replaceAllContent_, a full slice by child index) instead of
         * relying on DOM coordinates. start_/end_ still hold the first/last
         * rendered coordinates so consumers unaware of all_ (collaborative cursor
         * snapshots and the like) keep working.
         * Invalidation: any cursor write without `all` clears it naturally (the
         * whole object is replaced); the native select-all echo coming from
         * selectionchange is let through by a guard in the event layer.
         */
        all_?: boolean;
    },
}

export type ImageLoader = (src: string) => Promise<string>;

/**
 * Declarative inline syntax rule v2 (the `inlineRules` injection point).
 *
 * The kernel hardcodes only standard-markdown inline syntax; every extension
 * — including the kernel's own `==highlight==` — is expressed as a rule.
 * Passing `inlineRules` REPLACES the default set (spread `defaultInlineRules`
 * to keep `==`). Rules are data, not code: tokenization order, cursor
 * semantics and markdown round-trip stay inside the kernel. Only the render
 * channel (`component`) accepts functions — same trust level as
 * codeTokenizer; collaborative peers must inject the same rules.
 *
 * Syntax shape: `open` `{params}`? `content` `close` — always enclosed.
 * Every rule accepts an optional Pandoc/Djot-style parameter block right
 * after the open delimiter: `{.variant .class #id key=value key2="a b"}`.
 * The first `.word` selects a variant (see `variants`); every `.word` also
 * lands as a class, so unregistered variants degrade gracefully to CSS.
 *
 * Reserved delimiters (`< > [ * ~~ ![`) may be registered, but such rules
 * only fire on shapes the builtin never produces: a valid `{…}` capture
 * (`<{.mention id=1}Jintao Wang>` vs `<https://x>`), or a strictly longer open
 * (`[[wikilink]]` vs `[link](url)`). Precedence: user rule → builtin →
 * literal. `` ` `` `\` `{` `}` can never be part of a delimiter.
 *
 * Field names are public API (no `_` suffix — never mangled).
 */
export interface InlineRule {
    /** Opening delimiter, 1+ punctuation chars: "==", "%%", "<", "[[", "((". */
    open: string;
    /** Closing delimiter, may differ from `open`: ">", "]]", "))". */
    close: string;
    /** Run-shaped opens (single char repeated) only: true → the run must be
     *  exactly open.length chars (`^^x^` stays literal). false (default) →
     *  longer runs still open, matching the kernel's `==` behavior.
     *  Mixed-char delimiters always match exactly. */
    exactLen?: boolean;
    /** false → content with whitespace stays literal (sup/sub convention).
     *  Default true. */
    allowSpace?: boolean;
    /** true (default) → content recurses through inline parsing (nested
     *  `==**bold**==` works). false → content stays literal, like code spans. */
    parseInner?: boolean;

    /** Rendered tag name, whitelisted (sup/sub/mark/span/u/kbd/ins/…).
     *  Non-whitelisted names render as span. */
    tagName: string;
    /** Base className for the rendered element. */
    className?: string;
    /**
     * Declarative attribute templates resolved from the `{…}` params.
     * `{key}` substitutes a named param, `{}` the first positional one; an
     * attr referencing a missing param is voided entirely (never rendered
     * half-substituted). Targets are whitelisted: class / style / href /
     * title / id / data-* / aria-* — `on*` is unreachable, `style` is parsed
     * structurally, `javascript:` hrefs are rejected.
     *
     * ```ts
     * // `=={bg=red}x==` → translucent red highlight
     * attrs: { style: "background-color: color-mix(in srgb, {bg} 80%, transparent)" }
     * ```
     */
    attrs?: Record<string, string>;
    /** Custom render component (see InlineRuleComponentProps for the hard
     *  contract). View-layer only — parsing/round-trip never touch it. */
    component?: ComponentType<InlineRuleComponentProps>;
    /** Render branches selected by the params' first `.word`:
     *  `=={.comment author=w}text==` dispatches to `variants.comment`.
     *  Unset fields fall back to the rule-level config. */
    variants?: Record<string, InlineRuleVariant>;
}

/** Render config override for one `.variant` branch of an InlineRule. */
export interface InlineRuleVariant {
    tagName?: string;
    className?: string;
    attrs?: Record<string, string>;
    component?: ComponentType<InlineRuleComponentProps>;
    parseInner?: boolean;
}

/** Structured `{…}` params of one rule occurrence (Pandoc/Djot microsyntax:
 *  `.word` → variant+classes, `#word` → id, `key=value` → named, bare → positional). */
export interface InlineRuleParams {
    /** First `.word` — selects the render variant. */
    variant?: string;
    /** Every `.word`, in order (variant included). */
    classes: string[];
    /** `#id` — at most one, later wins. */
    id?: string;
    named: Record<string, string>;
    positional: string[];
}

/**
 * Props handed to an InlineRule `component`. HARD CONTRACT (violations break
 * cursor DOM↔model mapping — the kernel's render-id structure must survive):
 *   1. Spread `domProps` onto the component's ROOT element.
 *   2. Render `children` exactly as given (the kernel-rendered delimiter
 *      MdSymbols + content). Decorate around them freely; never re-write
 *      or drop them.
 *   3. Every decoration element you add (badges, icons, chrome) must spread
 *      `viewOnlyProps` — otherwise its text is read back as typed input on
 *      the next reparse and duplicates forever, and cursor offsets drift.
 * Everything else (onClick, tooltips, styling) is the host's own business.
 */
export interface InlineRuleComponentProps {
    /** Kernel element props (render-id, className, style, contentEditable…). */
    domProps: Record<string, any>;
    /** Kernel-rendered content — must be rendered verbatim. */
    children: ReactNode;
    /** Matched variant word, if any. */
    variant?: string;
    /** Structured `{…}` params of this occurrence. */
    params: InlineRuleParams;
    /** Raw `{…}` inner text, or null when no capture was written. */
    rawCapture: string | null;
    /** Raw inner markdown text of the content. */
    contentText: string;
    /** The tag the kernel would have rendered (dispatch result). */
    tagName: string;
}

/**
 * The key bound to "a real newline" in embed / chat-input mode.
 * Once it is configured, a bare Enter yields to the host (firing onEnter) and this
 * key is what produces newlines and block splits instead.
 * - 'Shift+Enter': Discord/Slack style (Enter submits, Shift+Enter breaks the line)
 * - 'Mod+Enter': Cmd/Ctrl+Enter breaks the line (Enter submits)
 */
export type NewlineKey = "Shift+Enter" | "Mod+Enter";

export interface StoreConstructorProps {
    editable: boolean;
    initMd?: string;
    placeholder?: string;
    /** EditorController display mode, default "markdown". Pure view preference:
     *  model / DOM text / round-trip are identical across modes, so
     *  collaborative peers may freely differ. Hot-switch via setMode(). */
    mode?: EditorMode;
    codeTokenizer?: (code: string, lang?: string) => Token[];
    /**
     * Code-beautifier injection point (js-beautify or similar — supplied by the
     * caller; core never depends on a concrete implementation).
     * Called with the whole code block after Enter is pressed inside it; `lang`
     * comes from the fence's ```lang.
     * Return the beautified code; return undefined to say "no beautifier for this
     * language" and core skips beautification.
     * Caveat: the incoming `code` carries the cursor marker as a statement (of the
     * form `console.log()`). The beautifier must keep that line's text
     * verbatim, otherwise this beautification pass is discarded.
     */
    codeBeautify?: (code: string, lang?: string) => string | undefined;
    htmlTokenizer?: (html: string) => Token[];
    /**
     * Declarative inline syntax injection point. Default = defaultInlineRules
     * (the `==` highlight). Passing a value REPLACES the whole set — spread
     * defaultInlineRules to keep `==`. Compiled once at construction; no
     * runtime hot-swap (remount the Provider to change rules). Collaborative
     * peers must inject the same set (same contract as codeTokenizer).
     */
    inlineRules?: InlineRule[];
    /**
     * Image-group aggregation switch + separator character set (opt-in). Passing
     * a value turns it on: ≥2 adjacent images at the top level of one P block are
     * wrapped in an ImgGroup node (default rendering is unchanged; a host can
     * override renderComponent[MarkdownType.ImgGroup] with a carousel or
     * anything else).
     * The value is the **set of characters** allowed in the separator text
     * between two images (not an exact string): `""` groups only images that
     * touch; `" "` covers any run of spaces; `", "` covers commas and spaces
     * mixed. The separator text is kept verbatim as a child of the group (the
     * round-trip stays byte-for-byte identical).
     * `\n` never qualifies (soft breaks do not group; grouping across a blank
     * line is unsupported). Omitting the prop leaves the feature entirely off and
     * the parse output matches earlier versions. Fixed at construction, no
     * hot-swap; collaborative peers must all be configured alike (the same
     * contract as inlineRules).
     */
    imgGroupSeparators?: string;
    imageLoader?: ImageLoader;
    /** Setting this switches to chat-input mode: newlines rebind to this key and
     *  a bare Enter yields to the host. */
    newlineKey?: NewlineKey;
    /**
     * Fires only in chat-input mode (newlineKey configured), outside IME
     * composition, on a "submit-flavoured" Enter. Core owns no submit semantics:
     * it hands the store back so the host can pull the document itself
     * (toMarkdown(store.renderData_)), together with the original KeyboardEvent
     * so the host can decide for itself based on modifier keys and the like.
     */
    onEnter?: (store: EditorStore, event: KeyboardEvent) => void;
}

export interface StoreState {
    renderData_: RootRenderData;
    editorState_: EditorState;
}

export interface DOMDProps {
    editable?: boolean;
    initMd: string;
    placeholder?: string;
    mode?: EditorMode;
    newlineKey?: NewlineKey;
    onEnter?: (store: EditorStore, event: KeyboardEvent) => void;
}

export interface DOMDRef {
    getStore: () => EditorStore;
    loadMd: () => void;
}

export interface CheckedTextRef {
    current: number;
}

export interface EditorDomContextValue {
    textAreaDomRef: RefObject<HTMLDivElement | null>;
}

export type AnyNode = RenderData | ParentRenderData;
export type TextLeaf = AnyNode & { text_: string };
