import { ZenithStore, createReactStore } from "@do-md/zenith";
import { withHistory } from "@do-md/zenith/middleware";
import {
    CompositionSnapshot,
    CursorInfo,
    CursorSource,
    EditorMode,
    FormatState,
    ImageLoader,
    InlineFormatMark,
    NewlineKey,
    ParentRenderData,
    PendingFormatMarks,
    PendingInput,
    RenderData,
    SelectionState,
    StoreConstructorProps,
    StoreState,
    Token,
} from "../type";
import { parseMarkdown } from "../../data-parse/parseMarkdown";
import {
    CompiledInlineRules,
    compileInlineRules,
} from "../../data-parse/inline-rules";
import { splitTextSpans } from "../../data-parse/postprocess/splitTextSpans";
import { EditorStateChainable, editorStateChainable } from "./chain";
import { MarkdownType } from "../type/enum";
import { createEmptyP } from "../../data-parse/create-render-data/createEmptyP";
import { getCursorInfoByParseData } from "../model/cursor/getCursorInfoByParseData";
import { getCursorRangeByParseData } from "../model/cursor/getCursorRangeByParseData";
import { getParentAndIndex } from "../model/tree/getParentAndIndex";
import { getNodeInfo } from "../model/tree/getNodeInfo";
import { getRenderDataById } from "../model/tree/getRenderDataById";
import { getTopLevelRenderDataById } from "../model/tree/getTopLevelRenderDataById";
import { inlineFormatHasStarConflict } from "../model/format/inlineFormatHasStarConflict";
import { computeFormatState } from "../model/format/computeFormatState";
import { isInlineRangeFullyMarked } from "../model/format/isInlineRangeFullyMarked";
import { wrapTextWithMarks } from "../model/format/wrapTextWithMarks";
import { toMarkdown } from "../model/serialize/toMarkdown";
import { CursorMarker } from "../constant";
import { normalizeRichCursorOffset } from "../model/rich/normalizeRichCursorOffset";
import { withSpanAnchor } from "../model/cursor/withSpanAnchor";
import { resolveCursorInfo } from "../model/cursor/resolveCursorInfo";
import { debounceWithRAF } from "@do-md/utils";
import { produce } from "immer";
import {
    diffRenderData,
    serializeRenderData,
    deserializeRenderData,
    applyRenderDataOpsToDraft,
    RenderDataOp,
    SerializedRenderData,
    CursorSnapshot,
} from "../model/sync/renderDataOps";
import {
    buildTopLevelSourceMap,
    planRangeEdits,
    resolveTextEdits,
    RangeEdit,
    TextEdit,
    ReplacePlan,
    ReplaceResult,
} from "../model/replace/plan";
import {
    blockTextOf,
    resolveOffsetToCursor,
    resolveSelectionTarget,
    SelectionResult,
    SelectionTarget,
} from "../model/selection/resolve";

/**
 * Trailing-paragraph invariant — THE single definition.
 *
 * A document whose last top-level block is structural (a code fence, a
 * table, a rule — anything that is not a paragraph) always gets a zero-width
 * autofill EmptyP appended, so the caret has a legal home below the last
 * block: clicks below the document land on it, and focus()'s last-block
 * fallback resolves to it instead of parking the cursor inside code/table
 * space. The EmptyP serializes to zero characters, so document bytes never
 * change; `isAutoFill_` is load-bearing — when the user types into the
 * block, the reparse promotes it to a real block and the autofill promotion
 * in store/chain splices in the missing `\n\n` separator keyed on exactly
 * this flag.
 *
 * Every entry that (re)builds the top-level tree enforces the rule through
 * this pair — the constructor, resetMD, setParsedData_ and
 * chainProduceParsedData_ — each applying it via its own mutation mechanism
 * (plain mutation, immer produce, store produce).
 */
const lacksTrailingParagraph = (root: ParentRenderData): boolean => {
    const last = root.children_.at(-1);
    return (
        last?.htmlType_ !== MarkdownType.EmptyP &&
        last?.htmlType_ !== MarkdownType.P
    );
};

const createTrailingParagraph = () => ({
    ...createEmptyP()[0],
    isAutoFill_: true,
});

export class EditorStore extends ZenithStore<StoreState> {
    private _codeTokenizer_?: (code: string, lang?: string) => Token[];
    private _codeBeautify_?: (code: string, lang?: string) => string | undefined;
    private _htmlTokenizer_?: (html: string) => Token[];
    private _inlineRules_: CompiledInlineRules;
    private _imgGroupSeparators_?: string;
    private _imageLoader_?: ImageLoader;
    private _newlineKey_?: NewlineKey;
    private _onEnter_?: (store: EditorStore, event: KeyboardEvent) => void;
    private _undo_;
    private _redo_;
    private _chunkGeneration_: number;

    constructor({
        editable: editable,
        initMd = "",
        placeholder,
        mode = "markdown",
        codeTokenizer,
        codeBeautify,
        htmlTokenizer,
        inlineRules,
        imgGroupSeparators,
        imageLoader,
        newlineKey,
        onEnter,
    }: StoreConstructorProps) {
        const INITIAL_CHUNK_LINES = 500;
        // CursorMarker (U+E000) is the kernel's PRIVATE cursor-position
        // protocol character: injected into intermediate text and consumed by
        // the parse that follows, never part of a document. External input is
        // stripped of it at every boundary (insertText already does this) —
        // both as hygiene and as self-healing: a marker that leaked into a
        // persisted document through a historical bug would otherwise glue
        // itself to a fence line and skew every offset-addressed command
        // after it, forever.
        initMd = initMd.replaceAll(CursorMarker, "");
        const initLines = initMd.split("\n");
        const initialMd =
            initLines.length > INITIAL_CHUNK_LINES
                ? initLines.slice(0, INITIAL_CHUNK_LINES).join("\n")
                : initMd;

        // Declarative inline rules: compiled once at construction (validate/
        // drop bad rules, bucket by char, build the dynamic escapable set),
        // read-only afterwards. undefined → defaults (`==` highlight).
        const compiledInlineRules = compileInlineRules(inlineRules);

        // The markdown-text → tree seam: pre-split large plain-text spans
        // (sentence-level CRDT granularity).
        const initialParsed = parseMarkdown(initialMd, {
            codeTokenizer_: codeTokenizer,
            placeholderText_: placeholder,
            inlineRules_: compiledInlineRules,
            imgGroupSeparators_: imgGroupSeparators,
        });
        splitTextSpans(initialParsed);

        // Trailing-paragraph invariant — see lacksTrailingParagraph above.
        if (lacksTrailingParagraph(initialParsed)) {
            initialParsed.children_.push(createTrailingParagraph());
        }

        if (
            initialParsed.children_.length === 1 &&
            initialParsed.children_[0].htmlType_ === MarkdownType.EmptyP
        ) {
            initialParsed.children_[0].htmlProps_.placeholder = placeholder;
        }

        super({
            renderData_: initialParsed,
            editorState_: {
                focusRequest_: 0,
                blurRequest_: 0,
                paddingMdSymbols_: null,
                activeAtomicUUID_: null,
                mode_: mode,
                pendingFormatMarks_: null,
                isEditable_: editable,
                pendingInput_: null,
                duringComposition_: false,
                compositionSnapshot_: null,
                renderUUID_: "",
                cursorInRender_: 0,
                cursorInfo_: {
                    start_: null,
                    end_: null,
                    source_: CursorSource.Model
                },
                placeholder_: placeholder,
            },
        });
        this._codeTokenizer_ = codeTokenizer;
        this._codeBeautify_ = codeBeautify;
        this._htmlTokenizer_ = htmlTokenizer;
        this._inlineRules_ = compiledInlineRules;
        this._imgGroupSeparators_ = imgGroupSeparators;
        this._imageLoader_ = imageLoader;
        this._newlineKey_ = newlineKey;
        this._onEnter_ = onEnter;
        this._chunkGeneration_ = 0;
        this.debounceApplyPendingText_ = debounceWithRAF(() => {
            if (this.duringComposition) return;
            this.applyPendingText_();
        }, 400);

        // Wire up undo/redo history.
        const { undo, redo } = withHistory(this, {
            maxLength: 30, // max history length
            debounceTime: 300, // debounce window (ms)
        });

        this._undo_ = undo;
        this._redo_ = redo;

        if (initLines.length > INITIAL_CHUNK_LINES) {
            this._chunkGeneration_ += 1;
            this._scheduleChunkedAppend_(
                initLines.slice(INITIAL_CHUNK_LINES),
                INITIAL_CHUNK_LINES,
                this._chunkGeneration_,
            );
        }
    }

    public undo() {
        this._undo_();
    }

    public redo() {
        this._redo_();
    }

    public get activeAtomicUUID_() {
        return this.state.editorState_.activeAtomicUUID_;
    }

    public get codeTokenizer_() {
        return this._codeTokenizer_;
    }

    public get codeBeautify_() {
        return this._codeBeautify_;
    }

    public get inlineRules_() {
        return this._inlineRules_;
    }

    public get imgGroupSeparators_() {
        return this._imgGroupSeparators_;
    }

    public get imageLoader_() {
        return this._imageLoader_;
    }

    public get newlineKey_() {
        return this._newlineKey_;
    }

    public get onEnter_() {
        return this._onEnter_;
    }

    public get paddingMdSymbols_() {
        return this.state.editorState_.paddingMdSymbols_;
    }

    public get duringComposition() {
        return this.state.editorState_.duringComposition_;
    }

    public get compositionSnapshot_() {
        return this.state.editorState_.compositionSnapshot_;
    }

    public get cursorInfo_() {
        return this.state.editorState_.cursorInfo_;
    }

    public get startCursorInfo() {
        return this.state.editorState_.cursorInfo_.start_;
    }

    public get endCursorInfo_() {
        return this.state.editorState_.cursorInfo_.end_;
    }

    public get renderData_() {
        return this.state.renderData_;
    }

    public get isEditable() {
        return this.state.editorState_.isEditable_;
    }

    /** Current display mode. Reactive — read via useEditorStore. */
    public get mode() {
        return this.state.editorState_.mode_;
    }

    /** Collapsed-format arming state (see PendingFormatMarks). Reactive. */
    public get pendingFormatMarks_() {
        return this.state.editorState_.pendingFormatMarks_;
    }

    /** armed marks at exactly this collapsed cursor, else null. */
    private _pendingMarksAt_(cur: {
        uuid: string;
        offset: number;
    }): InlineFormatMark[] | null {
        const p = this.pendingFormatMarks_;
        return p &&
            p.anchorUuid_ === cur.uuid &&
            p.anchorOffset_ === cur.offset
            ? p.marks_
            : null;
    }

    private _setPendingMarks_(
        cur: { uuid: string; offset: number },
        marks: InlineFormatMark[],
    ) {
        this.produce(
            (draft) => {
                draft.editorState_.pendingFormatMarks_ = marks.length
                    ? {
                          anchorUuid_: cur.uuid,
                          anchorOffset_: cur.offset,
                          marks_: marks,
                      }
                    : null;
            },
            { disableRecord: true },
        );
    }

    /**
     * The single implementation that consumes pending format marks: when
     * `target` hits the anchor, return the wrapped text plus the caret shift
     * (negative = park the caret before the close) and disarm; return null on a
     * miss. Shared by insertText (the typing takeover / the headless API) and the
     * IME compositionend snapshot path, so the wrapping semantics never fork.
     */
    public consumePendingFormatMarks_(
        text: string,
        target: { uuid: string; offset: number } | null | undefined,
    ): { text_: string; caretShift_: number } | null {
        if (!text || !target) return null;
        const marks = this._pendingMarksAt_(target);
        if (!marks) return null;
        const wrapped = wrapTextWithMarks(text, marks);
        this.clearPendingFormatMarks_();
        return {
            text_: wrapped.text_,
            caretShift_: -wrapped.closeLen_,
        };
    }

    /** Anchor hit test (does not consume) — the beforeinput router uses it to
     *  decide whether to take over; the actual wrapping and disarming happen in
     *  insertText's consumePendingFormatMarks_. */
    public isPendingFormatAnchor_(uuid: string, offset: number): boolean {
        return this._pendingMarksAt_({ uuid, offset }) !== null;
    }

    public clearPendingFormatMarks_() {
        if (!this.pendingFormatMarks_) return;
        this.produce(
            (draft) => {
                draft.editorState_.pendingFormatMarks_ = null;
            },
            { disableRecord: true },
        );
    }

    private _formatStateCache_: {
        cursor_: StoreState["editorState_"]["cursorInfo_"];
        data_: ParentRenderData;
        pending_: PendingFormatMarks | null;
        value_: FormatState;
    } | null = null;

    /**
     * Reactive formatting state at the current cursor/selection — the
     * state-first alternative to command-style isActive()/can() queries.
     * Pure derivation of (cursorInfo, renderData): recomputed only when
     * either reference changes, with a stable result reference so
     * `useEditorStore((s) => s.formatState)` re-renders exactly when the
     * state actually moved. Bind toolbar highlight to `.active` and
     * disabled state to `.can`; `can: true` guarantees `format(mark)` will
     * not be swallowed.
     */
    public get formatState(): FormatState {
        const cursor = this.state.editorState_.cursorInfo_;
        const data = this.state.renderData_;
        const pending = this.state.editorState_.pendingFormatMarks_;
        const cached = this._formatStateCache_;
        if (
            cached &&
            cached.cursor_ === cursor &&
            cached.data_ === data &&
            cached.pending_ === pending
        ) {
            return cached.value_;
        }
        const value = computeFormatState(
            data,
            cursor.start_,
            cursor.end_,
            this._inlineRules_.hasHighlight_,
            pending,
        );
        this._formatStateCache_ = {
            cursor_: cursor,
            data_: data,
            pending_: pending,
            value_: value,
        };
        return value;
    }

    public get placeholder_() {
        return this.state.editorState_.placeholder_;
    }

    public get pendingInput_() {
        return this.state.editorState_.pendingInput_;
    }

    public setActiveAtomicUUID_(uuid: string | null) {
        this.produce((draft) => {
            draft.editorState_.activeAtomicUUID_ = uuid;
            if (uuid) {
                draft.editorState_.cursorInfo_ = {
                    start_: null,
                    end_: null,
                    source_: CursorSource.Model
                }
            }
        });
    }

    public handleFocusImage(uuid: string) {
        const res = getParentAndIndex(uuid, this.renderData_);
        if (res) {
            const parent = res.parent;
            this.setPaddingMdSymbols_(parent.mdSymbols_);
            this.produce((draft) => {
                const symbolParseData = parent.children_[0];
                const cursorInfo = getCursorRangeByParseData(
                    symbolParseData,
                    this.renderData_,
                );
                if (cursorInfo) {
                    draft.editorState_.cursorInfo_ = {
                        start_: cursorInfo.startCursorInfo,
                        end_: cursorInfo.endCursorInfo,
                        source_: CursorSource.Model,
                    }
                }
            });
        }
    }

    /** Hand input focus back to the editor. The host's only focus entry point —
     *  the app layer talks to the store and never needs the editor instance.
     *
     *  The store layer is DOM-free: this never touches document, it only records
     *  the "focus" gesture as a state intent (incrementing focusRequest_); the
     *  render layer subscribes to it and translates it into the real DOM focus
     *  and cursor restore (see EditorProvider in render/react/components).
     *  disableRecord: focusing is not a document edit and must never land on the
     *  undo stack.
     *
     *  The semantics match the gesture layer: never destroy a live selection the
     *  user is holding; with no cursor, land at the end of the document. */
    public focus() {
        this.produce(
            (draft) => {
                draft.editorState_.focusRequest_ += 1;
            },
            { disableRecord: true },
        );
    }

    /** Focus-intent counter. For the render layer to subscribe to — hosts call
     *  focus() instead of reading this. */
    public get focusRequest_() {
        return this.state.editorState_.focusRequest_;
    }

    /** Give up input focus — the inverse of focus(). The model half lands
     *  immediately and DOM-free: pending speculative text commits, and the
     *  awareness gate closes so collaborative peers hide this cursor. The DOM
     *  half is an intent counter the render layer translates into a real blur
     *  on the contenteditable, which fires the ordinary blur chain
     *  (interaction layer, host cursor overlays) — all idempotent with the
     *  model half. The internal cursorInfo_ never moves, so a later focus()
     *  restores the caret where it was.
     *
     *  Hosts need this where the platform hides focus changes from the page:
     *  macOS WKWebView delivers no DOM blur when native chrome (a titlebar
     *  click) takes the window's first responder, leaving the editor
     *  half-alive — a blinking caret that no longer receives keys. Calling
     *  blur() keeps the page's focus state honest.
     *
     *  disableRecord: giving up focus is not a document edit. */
    public blur() {
        this.applyPendingText_();
        this.setCursorFocused_(false);
        this.produce(
            (draft) => {
                draft.editorState_.blurRequest_ += 1;
            },
            { disableRecord: true },
        );
    }

    /** Blur-intent counter. For the render layer to subscribe to — hosts call
     *  blur() instead of reading this. */
    public get blurRequest_() {
        return this.state.editorState_.blurRequest_;
    }

    public setEditable(editable: boolean) {
        this.produce((draft) => {
            draft.editorState_.isEditable_ = editable
        })
    }

    /** Hot-switch the display mode. View preference only: no model change,
     *  no reparse, no ops for collaborative peers. disableRecord so a later
     *  undo never flips the user's mode back. */
    public setMode(mode: EditorMode) {
        this.produce(
            (draft) => {
                draft.editorState_.mode_ = mode;
            },
            { disableRecord: true },
        );
    }

    public resetMD(text: string, disableRecord = true) {
        // External input boundary: strip the kernel's private CursorMarker —
        // see the constructor comment (hygiene + self-healing for documents
        // a historical bug leaked a marker into).
        text = text.replaceAll(CursorMarker, "");
        // Full-document replacement is a new baseline: invalidate any pending
        // chunked append (>500-line constructor / resetMDChunked), otherwise
        // stale ticks would splice the old tail lines into the new document.
        this._chunkGeneration_ += 1;
        const parsedData = parseMarkdown(text, {
            onCursorFound_: (cursorInfo) => {
                console.log(cursorInfo);
            },
            codeTokenizer_: this.codeTokenizer_,
            htmlTokenizer_: this._htmlTokenizer_,
            inlineRules_: this._inlineRules_,
            imgGroupSeparators_: this._imgGroupSeparators_,
            placeholderText_: this.placeholder_,
        });
        // The markdown-text → tree seam: pre-split large plain-text spans
        splitTextSpans(parsedData);
        // Trailing-paragraph invariant — see lacksTrailingParagraph above.
        if (lacksTrailingParagraph(parsedData)) {
            parsedData.children_.push(createTrailingParagraph());
        }
        this.produce(
            (state) => {
                state.renderData_ = parsedData;

                if (
                    state.renderData_.children_.length === 1 &&
                    state.renderData_.children_[0].htmlType_ === MarkdownType.EmptyP
                ) {
                    this.produce(
                        (draft) => {
                            draft.renderData_.children_[0].htmlProps_.placeholder =
                                this.placeholder_;
                        },
                        { disableRecord: disableRecord },
                    );
                }
            },
            { disableRecord: disableRecord },
        ); // this operation is not recorded
    }

    public resetMDChunked(text: string, chunkLines = 500) {
        // Same external-input boundary as resetMD: the tail chunks bypass
        // resetMD's own strip, so strip once up front.
        text = text.replaceAll(CursorMarker, "");
        const lines = text.split("\n");
        if (lines.length <= chunkLines) {
            this.resetMD(text);
            return;
        }

        // resetMD bumps the chunk generation (cancelling any earlier pending
        // load); capture it AFTER so our own scheduled appends stay valid.
        this.resetMD(lines.slice(0, chunkLines).join("\n"));
        const gen = this._chunkGeneration_;
        this._scheduleChunkedAppend_(lines.slice(chunkLines), chunkLines, gen);
    }

    public toMarkdown() {
        this.applyPendingText_();
        return toMarkdown(this.renderData_);
    }

    private _scheduleChunkedAppend_(
        remainingLines: string[],
        chunkLines: number,
        gen: number,
    ) {
        let offset = 0;
        const schedule = (cb: () => void) => {
            const g = globalThis as unknown as {
                requestIdleCallback?: (
                    cb: () => void,
                    opts?: { timeout: number },
                ) => number;
            };
            if (typeof g.requestIdleCallback === "function") {
                g.requestIdleCallback(cb, { timeout: 200 });
            } else {
                setTimeout(cb, 0);
            }
        };
        const tick = () => {
            if (gen !== this._chunkGeneration_) return;
            if (offset >= remainingLines.length) return;
            const end = Math.min(offset + chunkLines, remainingLines.length);
            const chunk = remainingLines.slice(offset, end).join("\n");
            this.appendMarkdownIncremental_(chunk);
            offset = end;
            schedule(tick);
        };
        schedule(tick);
    }

    public appendMarkdownIncremental_(chunk: string) {
        const target = this.renderData_.children_.at(-1) ?? this.renderData_;
        const oldText = toMarkdown(target);
        const newText = oldText + "\n" + chunk;
        this.chainProduceParsedData_((chain) => {
            chain.resetTextByUUID_(target.uuid_, newText);
        });
        this.setPendingInput_(null);
    }

    public chainProduceParsedData_ = (
        fn: (renderDataChainable: EditorStateChainable) => void,
        disableRecord = false,
    ) => {
        this.produce(
            (draft) => {
                fn(
                    editorStateChainable(
                        draft,
                        this.codeTokenizer_,
                        this._inlineRules_,
                        this._imgGroupSeparators_,
                    ),
                );
            },
            { disableRecord: disableRecord },
        );

        const parseData = this.renderData_;
        // Trailing-paragraph invariant — see lacksTrailingParagraph above.
        if (lacksTrailingParagraph(parseData)) {
            this.produce(
                (draft) => {
                    draft.renderData_.children_.push(
                        createTrailingParagraph(),
                    );
                },
                { disableRecord: disableRecord },
            );
        }
        if (
            parseData.children_.length === 1 &&
            parseData.children_[0].htmlType_ === MarkdownType.EmptyP
        ) {
            this.produce(
                (draft) => {
                    draft.renderData_.children_[0].htmlProps_.placeholder =
                        this.placeholder_;
                },
                { disableRecord: disableRecord },
            );
        }
    };

    public getTitle() {
        if (this.renderData_.children_.length === 0) return "";
        const title = toMarkdown(this.renderData_.children_[0]).trim();
        if (!title) return "";
        // strip leading #, list markers, blockquote, then inline *_`~
        return title
            .replace(/^(#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)/, "")
            .replace(/[*_`~]/g, "")
            .trim();
    }

    // ===== RenderData sync seam (for CRDT / persistence plugins; see
    // sync/constant.ts) =====

    private _syncOpsListeners_?: Set<(ops: RenderDataOp[]) => void>;
    private _suppressSyncOps_ = false;
    private _syncPrevRenderData_?: ParentRenderData;
    private _compositionEndWaiters_?: Set<() => void>;

    /**
     * Subscribe to the minimal op stream of the renderData tree (stable public
     * keys, immune to mangling).
     * Every state change yields one op array (one transaction, applied
     * atomically and in order).
     * Changes caused by applyExternalRenderData emit no ops (echo prevention).
     * Public API: consumed by CRDT / persistence plugins in the app layer.
     */
    public subscribeRenderDataOps(listener: (ops: RenderDataOp[]) => void) {
        if (!this._syncOpsListeners_) {
            this._syncOpsListeners_ = new Set();
            this._syncPrevRenderData_ = this.renderData_;
            this.subscribe((newState) => {
                const prev = this._syncPrevRenderData_!;
                const next = newState.renderData_;
                if (next === prev) return;
                // Advance the diff baseline whether or not emission is
                // suppressed, so the next diff stays correct.
                this._syncPrevRenderData_ = next;
                if (this._suppressSyncOps_) return;
                if (!this._syncOpsListeners_!.size) return;
                const ops = diffRenderData(prev, next);
                if (!ops.length) return;
                this._syncOpsListeners_!.forEach((l) => l(ops));
            });
        }
        this._syncOpsListeners_.add(listener);
        return () => {
            this._syncOpsListeners_?.delete(listener);
        };
    }

    /** Stable JSON snapshot of the current renderData tree (persist it, or seed
     *  a CRDT's initial state) */
    public getRenderDataSnapshot(): SerializedRenderData {
        return serializeRenderData(this.renderData_);
    }

    /**
     * Flush an input burst that speculative rendering has not committed to the
     * model yet (no-op when nothing is pending).
     * During IME composition the DOM belongs to compositionSnapshot_, so we wait
     * for compositionend to commit properly; callers only await and never have to
     * reason about composition state.
     * Sync / persistence callers should call this BEFORE reading a snapshot or
     * applying a remote merge, so that text being typed reaches the model and the
     * op stream instead of being washed away by an external whole-tree
     * replacement.
     * Public API: for CRDT / persistence plugins in the app layer.
     */
    public flushPendingInput(): Promise<void> {
        if (!this.duringComposition) {
            this.applyPendingText_();
            return Promise.resolve();
        }
        return this._waitForCompositionEnd_().then(() => {
            this.applyPendingText_();
        });
    }

    /**
     * Replace the whole renderData tree with stable JSON from the outside (a
     * remote merge / a load from persistence). It stays out of undo history and
     * broadcasts no ops (echo prevention). Note: replacing the whole tree leaves
     * the patches already on the undo stack without a referent, so callers should
     * treat this as a "new document baseline".
     */
    public applyExternalRenderData(json: SerializedRenderData) {
        // External tree replacement is a new document baseline — cancel any
        // pending chunked append from construction / resetMDChunked (stale
        // ticks would append the old initMd tail onto the new tree).
        this._chunkGeneration_ += 1;
        const tree = deserializeRenderData(json) as ParentRenderData;
        this._suppressSyncOps_ = true;
        try {
            this.produce(
                (draft) => {
                    draft.renderData_ = tree;
                    if (
                        draft.renderData_.children_.length === 1 &&
                        draft.renderData_.children_[0].htmlType_ === MarkdownType.EmptyP
                    ) {
                        draft.renderData_.children_[0].htmlProps_.placeholder = this.placeholder_;
                    }
                },
                { disableRecord: true },
            );
        } finally {
            this._suppressSyncOps_ = false;
        }
    }

    /**
     * The real-time collaboration hot path: apply a remote op stream surgically
     * onto the current tree (rendering costs O(changes)).
     * The counterpart to applyExternalRenderData (whole-tree replacement,
     * O(document)): immer allocates new objects only along the touched paths and
     * keeps every other reference → React memo hits across the board.
     * Local input bursts are flushed first (their ops broadcast through the
     * normal path); during IME composition we wait asynchronously for
     * compositionend to commit before applying. The application itself stays out
     * of undo and emits no ops (echo prevention).
     */
    public async applyExternalRenderDataOps(ops: RenderDataOp[]) {
        if (!ops.length) return;
        if (this.duringComposition) {
            await this.flushPendingInput();
        } else {
            // Keep the non-composition hot path synchronous: async functions
            // run synchronously until their first await.
            this.applyPendingText_();
        }
        this._suppressSyncOps_ = true;
        try {
            this.produce(
                (draft) => {
                    applyRenderDataOpsToDraft(draft, ops);
                },
                { disableRecord: true },
            );
        } finally {
            this._suppressSyncOps_ = false;
        }
        // Re-anchor after suppression is lifted: the cursor produce never
        // touches renderData_ (zero sync ops), but side effects such as
        // broadcasting and padding should run in their normal state.
        this._reanchorCursorAfterExternalOps_();
    }

    private _waitForCompositionEnd_(): Promise<void> {
        if (!this.duringComposition) return Promise.resolve();
        return new Promise((resolve) => {
            if (!this.duringComposition) {
                resolve();
                return;
            }
            (this._compositionEndWaiters_ ??= new Set()).add(resolve);
        });
    }

    /**
     * Re-resolve the local cursor through its span anchor after remote ops land
     * (the consuming side of same-block drift protection).
     * - Change outside the block: resolve returns the original coordinate →
     *   nothing happens at all (the dividend uuid addressing already pays);
     * - Same block, different span: the anchor holds the cursor to its text; we
     *   update the block-relative offset and go through the standard
     *   setCursorInfo_ (Model source → replayed by UseCursor);
     * - The cursor's own span was touched: resolve falls back to render +
     *   offset (clamped), equivalent to the behaviour before anchors existed;
     * - The cursor's block was deleted: leave everything as is (the replay side
     *   naturally no-ops on missing DOM);
     * - Blurred: skip — never fight the user's current selection for focus,
     *   cursorInfo_ stays put (consistent with the existing blur semantics: the
     *   internal cursor state already stops tracking while blurred).
     * When the position did not move but the anchor went stale (an equal-length
     * replacement / a formatting change swapped the span), refresh the anchor
     * silently and keep the original source_, so the next remote op is not forced
     * onto the coarse fallback.
     */
    private _reanchorCursorAfterExternalOps_() {
        if (!this._focused_) return;
        const { start_, end_, source_ } = this.state.editorState_.cursorInfo_;
        if (!start_) return;
        const root = this.renderData_;
        const newStart = resolveCursorInfo(start_, root);
        if (!newStart) return;
        const newEnd = end_ ? resolveCursorInfo(end_, root) : null;
        const moved =
            newStart.uuid !== start_.uuid ||
            newStart.offset !== start_.offset ||
            (end_
                ? !newEnd ||
                newEnd.uuid !== end_.uuid ||
                newEnd.offset !== end_.offset
                : false);
        if (moved) {
            this.setCursorInfo_(newStart, newEnd, CursorSource.Model);
            return;
        }
        const anchorChanged =
            newStart.spanUuid !== start_.spanUuid ||
            newStart.spanOffset !== start_.spanOffset ||
            (end_ && newEnd
                ? newEnd.spanUuid !== end_.spanUuid ||
                newEnd.spanOffset !== end_.spanOffset
                : false);
        if (!anchorChanged) return;
        this.produce((draft) => {
            draft.editorState_.cursorInfo_ = {
                start_: newStart,
                end_: newEnd,
                source_,
            };
        });
    }

    /**
     * Resolve a cursor coordinate (possibly carrying a span anchor) into a
     * block-level coordinate in the current tree.
     * Used to draw remote cursors: a CursorSnapshot entry arriving through
     * presence is resolved here before being positioned in the DOM
     * (data-render-id + a text walk), so a remote cursor does not drift while the
     * same block is being edited.
     * The tree walk happens inside core — the published build mangles the
     * `_`-suffixed fields away, so the app layer cannot walk the tree itself
     * (the same discipline as the sync seam). Returns null when the block is gone
     * (draw nothing).
     */
    public resolveCursorPosition(cursor: {
        uuid: string;
        offset: number;
        spanUuid?: string;
        spanOffset?: number;
    }): { uuid: string; offset: number } | null {
        const resolved = resolveCursorInfo(cursor, this.renderData_);
        return resolved
            ? { uuid: resolved.uuid, offset: resolved.offset }
            : null;
    }

    // ===== Local cursor exposure (for collaborative awareness; remote cursors
    // are maintained and drawn by the app layer) =====

    private _cursorListeners_?: Set<(cursor: CursorSnapshot) => void>;
    private _cursorEmitDeferred_ = false;
    /**
     * Whether the local editor holds focus (the outbound gate for awareness).
     * Defaults to true.
     * While blurred, the snapshot reports "no cursor" to the outside (start/end
     * both null), but the internal **cursorInfo_ is NOT cleared** —
     * aiInsertInCursor, focus restoration and padding computation still rely on
     * it.
     */
    private _focused_ = true;

    /**
     * Snapshot of the current cursor (stable public shape; start/end are null
     * when there is no cursor **or when the editor is blurred**).
     * Reporting null while blurred is awareness semantics: it tells peers to
     * "hide my cursor"; when focus comes back, setCursorFocused_(true) re-emits
     * the real snapshot.
     */
    public getCursorSnapshot(): CursorSnapshot {
        if (!this._focused_) {
            return { start: null, end: null };
        }
        const cursor = this.state.editorState_.cursorInfo_;
        // Span anchors ship out with the snapshot (the field names carry no `_`
        // suffix, so mangling leaves them alone): peers resolve them through
        // resolveCursorPosition before drawing, which keeps a remote cursor from
        // drifting while the same block is edited
        const toPublic = (c: CursorInfo | null) =>
            c
                ? {
                    uuid: c.uuid,
                    offset: c.offset,
                    ...(c.spanUuid !== undefined
                        ? { spanUuid: c.spanUuid, spanOffset: c.spanOffset }
                        : {}),
                }
                : null;
        return {
            start: toPublic(cursor.start_),
            end: toPublic(cursor.end_),
        };
    }

    /** Push the current snapshot straight to every awareness subscriber (used to
     *  force a re-emit on focus / blur) */
    private _emitCursorSnapshot_() {
        if (!this._cursorListeners_?.size) return;
        const snapshot = this.getCursorSnapshot();
        this._cursorListeners_.forEach((l) => l(snapshot));
    }

    /**
     * Set the local focus state and sync awareness. blur → false: the snapshot
     * reports null and peers hide this cursor; focus → true: the real snapshot is
     * re-emitted and peers bring it back. The internal cursorInfo_ never moves.
     * Driven by focus/blur events in the interaction layer.
     */
    public setCursorFocused_(focused: boolean) {
        if (this._focused_ === focused) return;
        this._focused_ = focused;
        this._emitCursorSnapshot_();
    }

    /**
     * Subscribe to local cursor changes (addressed by uuid + block-relative
     * offset — the applying peer needs no position mapping, since a remote change
     * outside the cursor's block cannot affect the local cursor anyway).
     *
     * Causal ordering guarantee: **a cursor event never refers to text peers
     * cannot see yet**. During speculative input (pendingInput_) or IME
     * composition, the cursor offset points at DOM text that has not reached the
     * model — and therefore has not been broadcast through the op stream — so we
     * hold the event back and record a deferred flag instead; when the input
     * commits, the renderData op broadcasts first and the state change that
     * clears pendingInput_ then triggers the pending emit → consumers always see
     * the order "text first, cursor second".
     */
    public subscribeCursorChange(listener: (cursor: CursorSnapshot) => void) {
        if (!this._cursorListeners_) {
            this._cursorListeners_ = new Set();
            this.subscribe((newState, prevState) => {
                const cursorChanged =
                    newState.editorState_.cursorInfo_ !==
                    prevState.editorState_.cursorInfo_;
                const blocked =
                    newState.editorState_.pendingInput_ !== null ||
                    newState.editorState_.duringComposition_;
                if (cursorChanged && blocked) {
                    // The cursor moved but the text has not committed: defer
                    // the emit until the block is lifted
                    this._cursorEmitDeferred_ = true;
                    return;
                }
                const shouldFlushDeferred =
                    this._cursorEmitDeferred_ && !blocked;
                if (!cursorChanged && !shouldFlushDeferred) return;
                this._cursorEmitDeferred_ = false;
                this._emitCursorSnapshot_();
            });
        }
        this._cursorListeners_.add(listener);
        return () => {
            this._cursorListeners_?.delete(listener);
        };
    }

    public setCursorInfo_(
        start: CursorInfo | null = null,
        end: CursorInfo | null = null,
        source: CursorSource = CursorSource.Model,
        // Model-source moves normally ride into the same history entry as the
        // edit that produced them (see the disableRecord note below). A caret
        // placement that is NOT the tail of an edit (setSelection) opts out:
        // recording it would push a pure-cursor entry onto the undo stack, so
        // undoing an AI edit would first rewind a selection nobody made.
        disableRecord: boolean = source === CursorSource.Dom,
        // The select-all terminal-state flag (see the comment on
        // EditorState.cursorInfo_.all_). Defaults to false: any ordinary cursor
        // write clears the terminal state — that is the structural implementation
        // of the invalidation rule, so no path has to clear the flag explicitly.
        // Only setSelectAll_ passes true.
        all: boolean = false,
    ) {
        // Derive the span anchor on every cursor write (O(nodes in the block)) —
        // under collaboration we re-resolve through the anchor once remote ops
        // land, so an edit to another span of the same block causes no drift.
        // During a pending burst the DOM runs ahead of the model and the offset
        // may be out of range → the derivation then gives up on anchoring (the
        // chain re-anchors once the input commits, so it self-heals). See
        // common/cursor/.
        const root = this.renderData_;
        const startAnchored = start ? withSpanAnchor(start, root) : null;
        const endAnchored = end ? withSpanAnchor(end, root) : null;
        // Same-position short circuit: when selectionchange replays the very
        // same position at high frequency (jitter after a click, scrolling), an
        // identical cursor write skips produce entirely — saving the padding
        // recomputation, the formatState re-derivation and a pointless re-render
        // in every subscriber. The atomic-selection state is the exception (a
        // cursor write also carries the job of clearing activeAtomicUUID_).
        const cur = this.state.editorState_.cursorInfo_;
        const sameEnd_ = (a: CursorInfo | null, b: CursorInfo | null) =>
            (!a && !b) ||
            (!!a &&
                !!b &&
                a.uuid === b.uuid &&
                a.offset === b.offset &&
                a.spanUuid === b.spanUuid &&
                a.spanOffset === b.spanOffset);
        if (
            !this.state.editorState_.activeAtomicUUID_ &&
            cur.source_ === source &&
            // A flip of all_ (raising or clearing it) must never short-circuit:
            // even when the coordinates happen to match we still have to run
            // produce, otherwise Cmd+A cannot enter the terminal state while the
            // selection already covers the whole document.
            (cur.all_ ?? false) === all &&
            sameEnd_(cur.start_, startAnchored) &&
            sameEnd_(cur.end_, endAnchored)
        ) {
            return;
        }
        this.produce(
            (draft) => {
                draft.editorState_.activeAtomicUUID_ = null;
                // Pending format marks only live at their anchor: the cursor
                // leaving the anchor (from any source) disarms them — this is the
                // single funnel every cursor write goes through, so no path needs
                // its own handling.
                const pending = draft.editorState_.pendingFormatMarks_;
                if (
                    pending &&
                    (!startAnchored ||
                        endAnchored ||
                        startAnchored.uuid !== pending.anchorUuid_ ||
                        startAnchored.offset !== pending.anchorOffset_)
                ) {
                    draft.editorState_.pendingFormatMarks_ = null;
                }
                draft.editorState_.cursorInfo_ = {
                    start_: startAnchored,
                    end_: endAnchored,
                    source_: source,
                    ...(all ? { all_: true } : {}),
                }
            },
            // DOM-sourced writes (selectionchange fires constantly) stay out of
            // undo history: otherwise drag-selecting / moving the caret floods and
            // pollutes the undo stack, and undoing one edit would rewind through
            // every caret stop along the way instead of returning to the previous
            // position. Model-sourced writes (the cursor after an edit commits)
            // keep being recorded — the cursor patch rides into the same history
            // entry as the renderData patch, which is what lets undo restore the
            // cursor with it. See selection-sync-design §4.
            { disableRecord },
        );
        this.updatePaddingMdSybolsAfterRender_();
    }

    /**
     * Enter the select-all terminal state (Cmd/Ctrl+A).
     * -------------------------------------------------------------------
     * This marks logical state only and never touches the DOM — the browser
     * paints the native select-all highlight itself (keydown does not
     * preventDefault), and UseCursor's gesture-fidelity guard skips the replay
     * because the source is Dom and a live selection exists inside the editor, so
     * the two never fight.
     * start_/end_ are written with the first/last rendered block coordinates (end
     * takes the full text length of the last render element in document order) so
     * that consumers unaware of all_ (collaborative cursor snapshots, the legacy
     * path in getSelectionState) still receive an "approximately whole document"
     * range; the real whole-document semantics come from the all_ flag — see
     * replaceAllContent_ on the consuming side.
     */
    /**
     * The echo handshake flag for the select-all terminal state: after Cmd+A's
     * keydown raises all_, it is the browser's default action that actually
     * applies the native select-all, and the first selectionchange reading to
     * arrive afterwards is the terminal state's own echo. Chrome snaps the
     * select-all endpoints to the first/last "visible" caret position (measured:
     * anchor = (first text, 0), focus = (trailing EmptyP, 0) — the endpoints sit
     * inside the elements), and hidden syntax drifts the model offset on top of
     * that, so every geometric test — coordinate equality, full containsNode
     * containment — is bound to mismatch. Hence the echo is detected with a
     * one-shot flag: setSelectAll_ raises it and the first reading in
     * handleSelectionChange consumes it (see the guard comment there).
     */
    public selectAllEchoPending_ = false;

    public setSelectAll_() {
        // Cmd+A during IME composition is meaningless input, and the DOM
        // belongs to compositionSnapshot_ at that point — do not enter the
        // terminal state.
        if (this.duringComposition) return;
        // Raised before the short-circuit check: a repeated Cmd+A (whose
        // unchanged coordinates would be short-circuited by setCursorInfo_) must
        // still refresh the handshake flag.
        this.selectAllEchoPending_ = true;
        const root = this.renderData_;
        const blocks = root.children_.filter(
            (c) => c.htmlProps_?.["data-render-id"],
        );
        if (!blocks.length) return;
        // The last render element in document order (table → last cell, code
        // block → last line): the end coordinate has to land on a leaf that can
        // hold a cursor, otherwise its uuid cannot be replayed into the DOM or
        // resolved by a collaborating peer.
        let endLeaf = blocks[blocks.length - 1] as ParentRenderData;
        const walk = (n: ParentRenderData | RenderData) => {
            for (const c of (n as ParentRenderData).children_ || []) {
                if (c.htmlProps_?.["data-render-id"]) {
                    endLeaf = c as ParentRenderData;
                }
                walk(c);
            }
        };
        walk(endLeaf);
        this.setCursorInfo_(
            { uuid: blocks[0].uuid_, offset: 0 },
            { uuid: endLeaf.uuid_, offset: blockTextOf(endLeaf).length },
            CursorSource.Dom,
            true, // a pure selection stays off the undo stack
            true, // all_
        );
    }

    /**
     * The consuming primitive of the select-all terminal state: whole-document
     * replacement (text="" clears the document).
     * -------------------------------------------------------------------
     * It uses neither the DOM nor cursor coordinates — "the whole document" has
     * no exact representation in the (uuid, offset) space (the serialization
     * scaffolding at the edges is outside the value range, and the still-unparsed
     * part of a chunked load is not even in the tree/DOM), so a full slice by
     * child index is the only lossless addressing. It reuses
     * replaceTopLevelSlice_: the same merge / identity / op machinery as a
     * selection edit — the uuid is kept when the first block's type lines up, ops
     * stay fine-grained, and it is one produce, one undo step. A CursorMarker is
     * appended to `text` so the parser reports the cursor back (when clearing,
     * the marker is the entire input → EmptyP with the cursor homed, and the
     * placeholder is restored by the empty-document normalization in
     * chainProduceParsedData_).
     * Chunk semantics: this is a "new baseline" — bump _chunkGeneration_ to
     * cancel an in-flight chunked append (resetMDChunked), otherwise a stale tick
     * would splice the old tail back in and a select-all delete would not
     * actually delete everything.
     */
    public replaceAllContent_(text: string) {
        this._chunkGeneration_ += 1;
        const total = this.renderData_.children_.length;
        this.chainProduceParsedData_((chain) => {
            chain.replaceTopLevelSlice_(
                0,
                total,
                text.replaceAll(CursorMarker, "") + CursorMarker,
                true,
            );
        });
        // Cursor fallback: when a marker-only (clearing) input parses to an
        // empty fragment, replaceTopLevelSlice_ takes the pure-splice branch and
        // reports no cursor, while the old cursor uuid vanished with the full
        // slice → home the caret to the start of the first block after
        // normalization (the EmptyP that chainProduceParsedData_ appends).
        // disableRecord: a cursor patch should never become an undo step of its
        // own.
        const start = this.startCursorInfo;
        if (!start || !getRenderDataById(start.uuid, this.renderData_)) {
            const first = this.renderData_.children_.find(
                (c) => c.htmlProps_?.["data-render-id"],
            );
            if (first) {
                this.setCursorInfo_(
                    { uuid: first.uuid_, offset: 0 },
                    null,
                    CursorSource.Model,
                    true,
                );
            }
        }
        this.setPendingInput_(null);
    }

    public updatePaddingMdSybolsAfterRender_() {
        if (!this.startCursorInfo) return;

        console.time("setPadding");
        const { uuid: uuid, offset: offset } = this.startCursorInfo;

        console.time("getData");
        const node = getRenderDataById(
            uuid,
            this.renderData_,
        ) as ParentRenderData;
        console.timeEnd("getData");
        if (!node) return;
        if (node.htmlType_ === MarkdownType.H1) {
            // debugger
        }
        console.time("getNodeInfo");
        const { curNode: parseNode } = getNodeInfo(offset, node);
        console.timeEnd("getNodeInfo");

        if (parseNode && parseNode.mdSymbols_.length) {
            this.setPaddingMdSymbols_(parseNode.mdSymbols_);
        } else {
            const { curNode: nextNode } = getNodeInfo(offset + 1, node);
            if (nextNode && nextNode.mdSymbols_.length) {
                this.setPaddingMdSymbols_(nextNode.mdSymbols_);
            } else {
                this.setPaddingMdSymbols_(null);
            }
        }
        console.timeEnd("setPadding");
    }

    public setPaddingMdSymbols_(mdSymbols: string[] | null) {
        this.produce(
            (draft) => {
                draft.editorState_.paddingMdSymbols_ = mdSymbols;
            },
            { disableRecord: true },
        );
    }

    public setPendingInput_(input: PendingInput | null) {
        // Clearing pending = the block's DOM buffer was already consumed by one
        // of the immediate-write paths (delete / closing reparse / enter / …).
        // In the snapshot-push model a flush consumes state only and never reads
        // the DOM — a timer waking up to null is naturally a no-op, so the whole
        // class of "resurrect stale text" bugs is structurally gone; we still
        // cancel the armed timer synchronously here, purely for economy (one
        // fewer pointless wake-up) and semantic tidiness.
        if (!input) {
            this.debounceApplyPendingText_.cancel();
        }
        this.produce(
            (draft) => {
                draft.editorState_.pendingInput_ = input;
            },
            { disableRecord: true },
        );
    }

    public insertCursorMarker_(text: string, cursorPos: number) {
        return text.slice(0, cursorPos) + CursorMarker + text.slice(cursorPos);
    }

    public debounceApplyPendingText_!: ReturnType<typeof debounceWithRAF>;

    public debounceSetCursorInfo_!: () => void;

    public toggleCheckbox_(id: string) {
        this.chainProduceParsedData_((chainable) => {
            chainable.toggleCheckbox_(id);
        });
    }

    /**
     * Flush a speculative input burst: consume the pendingInput_ snapshot the
     * input layer pushed at event time (pure state; the store touches no DOM).
     * The model is written first (so the op broadcasts first) and only then is
     * pending cleared — subscribeCursorChange's causal ordering depends on
     * exactly this sequence.
     */
    public applyPendingText_() {
        // During IME composition the DOM belongs to compositionSnapshot_: the
        // final text is committed by the compositionend path (the snapshot path
        // writes the model directly and clears pending; the fallback path,
        // parseInCursor_, pushes a fresh snapshot before it wakes any waiter).
        if (this.duringComposition) return;
        if (!this.isEditable) return;
        const pending = this.pendingInput_;
        if (!pending) return;

        this.chainProduceParsedData_((chain) => {
            chain.resetTextByUUID_(
                pending.uuid_,
                this.insertCursorMarker_(pending.text_, pending.offset_),
            );
        });
        this.setPendingInput_(null);
    }

    public setDuringComposition_(duringComposition: boolean) {
        const wasDuringComposition = this.duringComposition;
        this.produce(
            (draft) => {
                draft.editorState_.duringComposition_ = duringComposition;
            },
            { disableRecord: true },
        );
        if (wasDuringComposition && !duringComposition) {
            const waiters = this._compositionEndWaiters_;
            this._compositionEndWaiters_ = undefined;
            waiters?.forEach((resolve) => resolve());
        }
    }

    public setCompositionSnapshot_(snapshot: CompositionSnapshot | null) {
        this.produce(
            (draft) => {
                draft.editorState_.compositionSnapshot_ = snapshot;
            },
            { disableRecord: true },
        );
    }

    public setParsedData_ = (parseData: ParentRenderData) => {
        // Trailing-paragraph invariant — see lacksTrailingParagraph above.
        // (This site historically omitted isAutoFill_; unified deliberately:
        // the flag is what keys the separator-splicing autofill promotion.)
        if (lacksTrailingParagraph(parseData)) {
            parseData = produce(parseData, (draft) => {
                draft.children_.push(createTrailingParagraph());
            });
        }
        if (
            parseData.children_.length === 1 &&
            parseData.children_[0].htmlType_ === MarkdownType.EmptyP
        ) {
            parseData = produce(parseData, (draft) => {
                draft.children_[0].htmlProps_.placeholder = this.placeholder_;
            });
        }

        this.produce(
            (draft) => {
                draft.renderData_ = parseData;
            },
            { disableRecord: false },
        );
    };

    public checkPadding_(data: RenderData | ParentRenderData): boolean {
        if (!this.paddingMdSymbols_) return false;
        return data.mdSymbols_.every((symbol) =>
            this.paddingMdSymbols_?.find((s) => s === symbol),
        );
    }

    public deleteRange() {
        // Select-all terminal state: coordinate addressing cannot reach the edge
        // scaffolding or the not-yet-loaded chunks — use the whole-document
        // primitive
        if (this.cursorInfo_.all_) {
            this.replaceAllContent_("");
            return;
        }
        if (!this.startCursorInfo || !this.endCursorInfo_) return;

        this.chainProduceParsedData_((chain) => {
            if (!this.startCursorInfo || !this.endCursorInfo_) return;
            chain.deleteSelect_(
                [this.startCursorInfo, this.endCursorInfo_].map(
                    this.adjustCursor_,
                ),
            );
        });

        this.updatePaddingMdSybolsAfterRender_();
    }

    //todo: this only adjusts the cursor; deleting the paragraph would make more sense
    public adjustCursor_ = (cursor: CursorInfo) => {
        return {
            uuid: cursor.uuid,
            offset: cursor.offset,
        };
    };

    /**
     * Snapshot of the user's current selection / cursor context.
     *
     * Field semantics:
     * - `has_selection`: false = single caret point, true = real range selection
     * - `selected_text`: contents of the range (empty when has_selection is false)
     * - `before` / `after`: surrounding markdown text, each truncated to at most
     *   `contextChars` characters
     * - `before_truncated` / `after_truncated`: true if there is more text
     *   before/after that we did NOT include. False means the returned string
     *   reaches the document boundary on that side.
     *
     * Consumed by the CLI server (`domd-cli selection` → MCP tool
     * `domd_get_selection`) so an external agent can read what the user is
     * editing without poking at the DOM.
     */
    /**
     * Absolute offsets of the current cursor / selection into the canonical
     * `toMarkdown()` output — the read-only dual of
     * `setSelection`(SelectionRangeTarget), and the return value can be fed
     * straight back into setSelection / replaceRanges. Higher-level commands
     * (heading / list / quote toggles) use it to locate a line range before
     * rewriting prefixes, instead of computing offsets themselves.
     *
     * - Collapsed cursor → start === end;
     * - Select-all terminal state (cursorInfo_.all_) → { 0, md.length };
     * - No cursor, or a cursor that went stale (its uuid is no longer in the
     *   tree) → null; callers should disable the operation rather than guess a
     *   position.
     *
     * Same marker-injection mechanism as getSelectionState. Table column widths
     * are measured on the marker-stripped text (see renderTable), and once the
     * markers are removed the marked serialization is byte-for-byte identical to
     * the canonical one — which is why the offsets are exact inside tables too.
     */
    public getSelectionOffsets(): { start: number; end: number } | null {
        if (this.cursorInfo_.all_) {
            return { start: 0, end: toMarkdown(this.renderData_).length };
        }
        const start = this.startCursorInfo;
        if (!start) return null;
        const end = this.endCursorInfo_;
        const hasRange =
            !!end && (end.uuid !== start.uuid || end.offset !== start.offset);
        const cursors: CursorInfo[] = hasRange ? [start, end!] : [start];
        const marked = toMarkdown(this.renderData_, cursors);
        const firstAt = marked.indexOf(CursorMarker);
        if (firstAt < 0) return null;
        if (!hasRange) return { start: firstAt, end: firstAt };
        const secondAt = marked.indexOf(
            CursorMarker,
            firstAt + CursorMarker.length,
        );
        if (secondAt < 0) return { start: firstAt, end: firstAt };
        // Anchor/focus order isn't guaranteed — normalize to start <= end; the
        // second marker's offset has to lose the length of the first marker
        // itself.
        return {
            start: Math.min(firstAt, secondAt),
            end: Math.max(firstAt, secondAt) - CursorMarker.length,
        };
    }

    public getSelectionState(contextChars: number = 800): SelectionState {
        // Select-all terminal state: the selected content IS the full
        // serialization (including the edge scaffolding no coordinate can
        // express), so skip the marker-injection path.
        if (this.cursorInfo_.all_) {
            const md = toMarkdown(this.renderData_);
            return {
                has_selection: md.length > 0,
                selected_text: md,
                before: "",
                after: "",
                before_truncated: false,
                after_truncated: false,
            };
        }
        const start = this.startCursorInfo;
        const end = this.endCursorInfo_;

        // No cursor placed yet (e.g. window just opened, user hasn't clicked).
        // Surface as much trailing context as we have so the AI can still
        // append intelligently.
        if (!start) {
            const md = toMarkdown(this.renderData_);
            return {
                has_selection: false,
                selected_text: "",
                before: "",
                after: md.slice(0, contextChars),
                before_truncated: false,
                after_truncated: md.length > contextChars,
            };
        }

        // Only count it as a range when start and end actually differ.
        const hasRange =
            !!end && (end.uuid !== start.uuid || end.offset !== start.offset);

        // Let toMarkdown inject CursorMarker(s) — way easier than mapping
        // {uuid_, offset_} to a character offset ourselves, since the
        // renderData → markdown walk is non-trivial (lists, tables, code
        // fences all inject their own scaffolding).
        const cursors: CursorInfo[] = hasRange ? [start, end!] : [start];
        const marked = toMarkdown(this.renderData_, cursors);

        const firstAt = marked.indexOf(CursorMarker);
        if (firstAt < 0) {
            // Cursor uuid no longer in renderData (stale after edit).
            // Fall back to "caret at doc end".
            const md = toMarkdown(this.renderData_);
            const tail = Math.max(0, md.length - contextChars);
            return {
                has_selection: false,
                selected_text: "",
                before: md.slice(tail),
                after: "",
                before_truncated: tail > 0,
                after_truncated: false,
            };
        }

        let startIdx: number;
        let endIdx: number;
        if (hasRange) {
            const secondAt = marked.indexOf(
                CursorMarker,
                firstAt + CursorMarker.length,
            );
            if (secondAt < 0) {
                startIdx = firstAt;
                endIdx = firstAt;
            } else {
                // Anchor/focus order isn't guaranteed; normalize so startIdx
                // is always the smaller offset. Subtract one marker length
                // from the trailing index because removing the first marker
                // shifts everything after it left.
                const lo = Math.min(firstAt, secondAt);
                const hi = Math.max(firstAt, secondAt) - CursorMarker.length;
                startIdx = lo;
                endIdx = hi;
            }
        } else {
            startIdx = firstAt;
            endIdx = firstAt;
        }

        // Strip every marker to get the clean markdown for slicing.
        const md = marked.split(CursorMarker).join("");

        const selectedText =
            startIdx === endIdx ? "" : md.slice(startIdx, endIdx);
        const beforeStart = Math.max(0, startIdx - contextChars);
        const afterEnd = Math.min(md.length, endIdx + contextChars);

        return {
            has_selection: hasRange && selectedText.length > 0,
            selected_text: selectedText,
            before: md.slice(beforeStart, startIdx),
            after: md.slice(endIdx, afterEnd),
            before_truncated: startIdx > contextChars,
            after_truncated: endIdx + contextChars < md.length,
        };
    }

    /**
     * Insert `text` at the cursor.
     *
     * @param text         the content to insert; any CursorMarker is stripped
     *                     from it first.
     * @param cursorInfo   where to insert; omitted → falls back to the current
     *                     cursor, then to the end of the last block.
     * @param cursorOffset where the caret ends up, measured **relative to the
     *                     end of the inserted text**:
     *                     - `0` (the default) — the caret lands after the whole
     *                       inserted content (the original behaviour).
     *                     - negative — walk back from the end, e.g. inserting
     *                       `"paragraph"` with `-3` leaves the caret right
     *                       after `"paragr"`.
     *                     - positive — move right, past the text that already
     *                       followed the insertion point.
     *                     The result is clamped to the current block's text.
     *
     * Selection semantics: with no `cursorInfo` and a **real range selection**
     * held, the selection is deleted first and the text inserted in its place
     * (what typing over a selection does for a human) — the delete and the insert
     * combine into a single replaceSelect_, on the same op stream as manual
     * input: one produce, one undo step, and span identity inside the block is
     * preserved as usual. A caller that passes `cursorInfo` explicitly has named
     * the insertion point, so the selection is left alone.
     */
    public insertText(
        text: string,
        cursorInfo?: CursorInfo,
        cursorOffset = 0,
    ) {
        text = text.replaceAll(CursorMarker, "");
        // Select-all terminal state: an insert with no explicit target IS a
        // whole-document replacement (what typing / pasting over a select-all
        // does for a human). A caller that passes cursorInfo named the insertion
        // point, so as usual the selection is left alone. Pending format marks
        // were already disarmed by setCursorInfo_ when the terminal state was
        // entered, so this branch has nothing to consume.
        if (!cursorInfo && this.cursorInfo_.all_) {
            this.replaceAllContent_(text);
            if (cursorOffset !== 0) this._shiftCursor_(cursorOffset);
            return;
        }
        // Pending format marks: the target cursor is still at the anchor → wrap
        // the text in the delimiters and park the caret before the close (so
        // typing keeps flowing inside the construct), then disarm.
        const wrapped = this.consumePendingFormatMarks_(
            text,
            cursorInfo ?? this.startCursorInfo,
        );
        if (wrapped) {
            text = wrapped.text_;
            cursorOffset += wrapped.caretShift_;
        }
        const selStart = this.startCursorInfo;
        const selEnd = this.endCursorInfo_;
        if (
            !cursorInfo &&
            selStart &&
            selEnd &&
            (selEnd.uuid !== selStart.uuid || selEnd.offset !== selStart.offset)
        ) {
            this.chainProduceParsedData_((chain) => {
                chain.replaceSelect_(
                    [selStart, selEnd].map(this.adjustCursor_),
                    text,
                );
            });
            // replaceSelect_ leaves the caret right after the inserted text;
            // honour cursorOffset by shifting from there (same clamp rule).
            if (cursorOffset !== 0) this._shiftCursor_(cursorOffset);
            return;
        }
        const cursor =
            cursorInfo ||
            this.startCursorInfo ||
            getCursorInfoByParseData(this.renderData_.children_.at(-1));

        if (!cursor) {
            debugger;
            return;
        }

        const { uuid: uuid_, offset: offset_ } = cursor;

        const renderData = getTopLevelRenderDataById(
            uuid_,
            this.renderData_,
        ) as ParentRenderData;
        if (!renderData) {
            debugger;
            return;
        }

        const oldText = toMarkdown(renderData, [
            { uuid: uuid_, offset: offset_ },
        ]);
        const [preText, nextText = ""] = oldText.split(CursorMarker);
        const cursorIndex = preText.length;

        const mergedText = preText + text + nextText;
        // By default the caret lands at the end of the inserted text
        // (cursorIndex + text.length); cursorOffset shifts it relative to that
        // end (a negative value walks back into the inserted content), and the
        // result is clamped to the block's text.
        const caretPos = Math.max(
            0,
            Math.min(
                mergedText.length,
                cursorIndex + text.length + cursorOffset,
            ),
        );
        const newText = this.insertCursorMarker_(mergedText, caretPos);

        this.chainProduceParsedData_((chain) => {
            chain.resetTextByUUID_(renderData.uuid_, newText);
        });
        // this.setPendingInput_(null);
        // this.updatePaddingMdSybolsAfterRender_();
    }

    /** Move the collapsed caret by `delta` inside its current block, clamped
     *  to the block's text. Not an edit — no history entry. */
    private _shiftCursor_(delta: number) {
        const cursor = this.startCursorInfo;
        if (!cursor) return;
        const block = getRenderDataById(cursor.uuid, this.renderData_);
        const max = block ? blockTextOf(block).length : cursor.offset;
        this.setCursorInfo_(
            {
                uuid: cursor.uuid,
                offset: Math.max(0, Math.min(max, cursor.offset + delta)),
            },
            null,
            CursorSource.Model,
            true,
        );
    }

    // ===== Batch replace primitives (AI editing / external diff reconcile) =====

    /**
     * Batch replace by absolute ranges. Offsets index the CURRENT document's
     * serialized markdown (`toMarkdown()` output, LF). All edits are resolved
     * against one pristine snapshot BEFORE anything executes, so earlier
     * replacements never invalidate later positions:
     *   - edits sharing a top-level block are merged and spliced into that
     *     block slice's original text in a single string pass;
     *   - disjoint groups execute in descending document order (a splice
     *     never moves anything before it — serialization is per-child concat).
     * Each group then goes through the same scoped-reparse machinery as a
     * selection edit (fragment parse → mergeParsedBlock keeps the first
     * block's uuid and untouched span references → splice), so the change
     * reaches collaborators as ordinary fine-grained RenderDataOps — never a
     * whole-tree replacement — and the whole batch lands as ONE undo step
     * (single produce; the withHistory debounce folds the autofill fixups in).
     *
     * Failure policy: best effort. Malformed / out-of-bounds / overlapping
     * edits fail individually (overlap fails ALL edits involved) and are
     * reported in the result; the rest still apply. Zero applicable edits →
     * complete no-op (no state change, no history entry).
     */
    public replaceRanges(...edits: RangeEdit[]): ReplaceResult {
        this.applyPendingText_();
        const map = buildTopLevelSourceMap(this.renderData_);
        const indexed = edits.map((edit, argIndex) => ({
            ...edit,
            argIndex_: argIndex,
        }));
        const plan = planRangeEdits(indexed, map);
        this._executeReplacePlan_(plan);
        return plan.result_;
    }

    /**
     * Batch replace by exact-text search (the AI-editing flavor). Every
     * search matches against the same pristine serialization; matches are
     * counted non-overlapping, left to right. Duplicate matches without an
     * `occurrence` fail that edit with "ambiguous" (distinct from
     * "not_found"). Matched edits share the range pipeline with
     * `replaceRanges` — same grouping, ordering, identity and undo semantics.
     */
    public replaceText(...edits: TextEdit[]): ReplaceResult {
        this.applyPendingText_();
        const map = buildTopLevelSourceMap(this.renderData_);
        const { ranges_, failures_ } = resolveTextEdits(edits, map.docText_);
        const plan = planRangeEdits(ranges_, map, failures_);
        this._executeReplacePlan_(plan);
        return plan.result_;
    }

    /**
     * Place the model caret / selection programmatically — the read-only twin
     * of the replace primitives. Addressing is theirs, verbatim: exact text
     * match with `occurrence` disambiguation (replaceText's), or absolute
     * offsets into the current `toMarkdown()` serialization (replaceRanges').
     * A successful call echoes the resolved absolute range, so the caller can
     * hand it straight to `replaceRanges` for the first streamed chunk.
     *
     *   { search, occurrence?, collapse? } — no `collapse`: the selection
     *       covers the match; "start" / "end": collapsed caret at its head /
     *       tail. No match → "not_found"; several matches without
     *       `occurrence` → "ambiguous" (same verdicts replaceText gives).
     *   { start, end? } — `end` omitted or equal to `start` → collapsed
     *       caret. Outside [0, doc length] → "out_of_bounds".
     *
     * Pure model state: no DOM is touched or required, so a headless agent
     * store can select text and broadcast it through collab presence. On a
     * mounted store the browser selection follows through the normal
     * cursor → DOM replay (UseCursor), like the caret restore after an undo.
     *
     * The placed cursor carries span anchors, so `getCursorSnapshot()`
     * reflects it immediately and remote peers can re-resolve it across
     * concurrent edits. `subscribeCursorChange` fires exactly once. A failed
     * call leaves the existing cursor untouched (it never reaches the state).
     * Offsets that land in serialization scaffolding — a list marker, a table
     * pipe, a code fence — snap to the nearest legal caret position, the same
     * way the parser resolves a marker a user typed there.
     */
    public setSelection(target: SelectionTarget): SelectionResult {
        // Same hygiene as the replace primitives: a speculative typing burst
        // must land in the model before offsets can index its serialization.
        this.applyPendingText_();
        const map = buildTopLevelSourceMap(this.renderData_);
        const resolved = resolveSelectionTarget(target, map.docText_);
        if ("reason_" in resolved) {
            return { applied: false, reason: resolved.reason_ };
        }
        const parseOptions = {
            codeTokenizer_: this._codeTokenizer_,
            inlineRules_: this._inlineRules_,
            imgGroupSeparators_: this._imgGroupSeparators_,
        };
        const start = resolveOffsetToCursor(
            this.renderData_,
            map,
            resolved.start_,
            "start",
            parseOptions,
        );
        if (!start) return { applied: false, reason: "invalid" };
        // Collapsed carets keep end_ null — the shape every edit path produces
        // (chain.setStartCursorInfo_), so consumers need no special case.
        let end: CursorInfo | null = null;
        if (resolved.end_ !== resolved.start_) {
            end = resolveOffsetToCursor(
                this.renderData_,
                map,
                resolved.end_,
                "end",
                parseOptions,
            );
            if (!end) return { applied: false, reason: "invalid" };
            if (end.uuid === start.uuid && end.offset === start.offset) {
                end = null;
            }
        }
        this.setCursorInfo_(start, end, CursorSource.Model, true);
        return { applied: true, start: resolved.start_, end: resolved.end_ };
    }

    private _executeReplacePlan_(plan: ReplacePlan) {
        if (!plan.groups_.length) return;
        this.chainProduceParsedData_((chain) => {
            // Groups are pre-sorted descending by child index.
            for (const group of plan.groups_) {
                chain.replaceTopLevelSlice_(
                    group.startIndex_,
                    group.deleteCount_,
                    group.newText_,
                );
            }
        });
        // The edits may have moved text under the local cursor — re-resolve
        // it through its span anchor exactly like a remote op batch would
        // (span survives → glued to its text; span gone → clamped fallback;
        // block gone / unfocused → leave as is).
        this._reanchorCursorAfterExternalOps_();
    }

    /** Column index of the TH/TD that IS `uuid` or CONTAINS it, across the
     *  header row and every body row. -1 when the uuid pins no cell. */
    private _findTableColumnOf_(
        table: ParentRenderData,
        uuid: string,
    ): number {
        const trs: (ParentRenderData | RenderData)[] = [];
        const headerTr = table.children_?.[0]?.children_?.[0];
        if (headerTr) trs.push(headerTr);
        trs.push(...(table.children_?.[1]?.children_ || []));
        for (const tr of trs) {
            const cells = tr.children_ || [];
            for (let i = 0; i < cells.length; i++) {
                const cell = cells[i];
                if (
                    cell.uuid_ === uuid ||
                    getParentAndIndex(uuid, cell as ParentRenderData)
                ) {
                    return i;
                }
            }
        }
        return -1;
    }

    /** Top-level Table child that IS `uuid` or CONTAINS it — callers may
     *  pass the table's own uuid or any cell/span uuid inside it. */
    private _locateTopLevelTable_(
        uuid: string,
    ): { index_: number; table_: ParentRenderData } | null {
        const children = this.renderData_.children_;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.htmlType_ !== MarkdownType.Table) continue;
            if (
                child.uuid_ === uuid ||
                getParentAndIndex(uuid, child as ParentRenderData)
            ) {
                return { index_: i, table_: child as ParentRenderData };
            }
        }
        return null;
    }

    /**
     * Structural table op: insert an empty row into the table that is (or
     * contains) `tableUuid`. `rowIndex` = 0-based position among BODY rows
     * (0 = right below the header); omitted → append at the bottom.
     *
     * Expressed as a text edit, not model surgery (declare & reconcile): the
     * table block is serialized, the new row line is spliced in, and the
     * block goes back through the same scoped-reparse machinery as typing
     * (replaceTopLevelSlice_) — undo (one step), fine-grained op emission
     * and cursor replay behave exactly like a user edit. The caret lands in
     * the new row's first cell (CursorMarker embedded in the block text).
     *
     * Returns false (complete no-op) when the uuid resolves to no top-level
     * table, the table has no header cells, or the index is out of range.
     */
    public addTableRow(tableUuid: string, rowIndex?: number): boolean {
        this.applyPendingText_();
        const located = this._locateTopLevelTable_(tableUuid);
        if (!located) return false;
        const { index_, table_ } = located;
        // THead > TR > TH count = column count; TBody children = body rows.
        const cols =
            table_.children_?.[0]?.children_?.[0]?.children_?.length || 0;
        if (!cols) return false;
        const bodyCount = table_.children_?.[1]?.children_?.length || 0;
        const insertAt = rowIndex === undefined ? bodyCount : rowIndex;
        if (
            !Number.isInteger(insertAt) ||
            insertAt < 0 ||
            insertAt > bodyCount
        ) {
            return false;
        }
        // Serialized table: line 0 = header, 1 = separator, 2+ = body rows
        // (1:1 with TBody TRs — autofill rows serialize as their raw line).
        const lines = (toMarkdown(table_) || "").split("\n");
        const cells: string[] = new Array(cols).fill("");
        cells[0] = CursorMarker;
        lines.splice(2 + insertAt, 0, `| ${cells.join(" | ")} |`);
        this.chainProduceParsedData_((chain) => {
            chain.replaceTopLevelSlice_(index_, 1, lines.join("\n"), true);
        });
        return true;
    }

    /**
     * Structural table op: insert an empty column into the table that is (or
     * contains) `tableUuid`. `colIndex` = 0-based column position; omitted →
     * append at the right. Same text-edit pipeline as addTableRow; the caret
     * lands in the new column's HEADER cell. Rows not pipe-wrapped on both
     * sides (AI-stream autofill rows) are left untouched — the parser treats
     * them as mid-stream input, and cell padding renormalizes on reparse.
     */
    public addTableColumn(tableUuid: string, colIndex?: number): boolean {
        this.applyPendingText_();
        const located = this._locateTopLevelTable_(tableUuid);
        if (!located) return false;
        const { index_, table_ } = located;
        const cols =
            table_.children_?.[0]?.children_?.[0]?.children_?.length || 0;
        if (!cols) return false;
        const insertAt = colIndex === undefined ? cols : colIndex;
        if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > cols) {
            return false;
        }
        const lines = (toMarkdown(table_) || "").split("\n");
        const newLines = lines.map((line, i) => {
            const hasLeading = line.startsWith("|");
            const hasTrailing = line.length > 1 && line.endsWith("|");
            if (!hasLeading || !hasTrailing) return line; // autofill row
            // Bare-pipe cell split — the exact convention parseTable uses.
            const rowCells = line.slice(1, -1).split("|");
            const filler =
                i === 0 ? CursorMarker : i === 1 ? "---" : "";
            rowCells.splice(
                Math.min(insertAt, rowCells.length),
                0,
                ` ${filler} `,
            );
            return `|${rowCells.join("|")}|`;
        });
        this.chainProduceParsedData_((chain) => {
            chain.replaceTopLevelSlice_(index_, 1, newLines.join("\n"), true);
        });
        return true;
    }

    /** Insert the CursorMarker at offset 0 of a table line's FIRST cell —
     *  after the "| " boundary, so the reparsed cell text stays byte-equal
     *  to the old one (the kept node then swallows the caret via the merge
     *  uuid remap). */
    private _injectCursorAtFirstCell_(line: string): string {
        if (line.startsWith("| ")) return "| " + CursorMarker + line.slice(2);
        if (line.startsWith("|")) return "|" + CursorMarker + line.slice(1);
        return CursorMarker + line;
    }

    /**
     * Structural table op: delete a BODY row. `rowIndex` = 0-based body row;
     * omitted → inferred from `tableUuid` (the body row containing that
     * uuid — pass the caret/cell uuid; a bare table uuid cannot infer).
     * Same text-edit pipeline as addTableRow. The caret lands in the first
     * cell of the row that takes the deleted slot (falling back to the last
     * remaining row, then the header). Deleting the last body row is legal —
     * a header-only table still parses as a table.
     */
    public deleteTableRow(tableUuid: string, rowIndex?: number): boolean {
        this.applyPendingText_();
        const located = this._locateTopLevelTable_(tableUuid);
        if (!located) return false;
        const { index_, table_ } = located;
        const cols =
            table_.children_?.[0]?.children_?.[0]?.children_?.length || 0;
        if (!cols) return false;
        const bodyRows = table_.children_?.[1]?.children_ || [];
        if (!bodyRows.length) return false;
        let target = rowIndex;
        if (target === undefined) {
            target = bodyRows.findIndex(
                (tr) =>
                    tr.uuid_ === tableUuid ||
                    getParentAndIndex(tableUuid, tr as ParentRenderData),
            );
        }
        if (
            !Number.isInteger(target) ||
            target < 0 ||
            target >= bodyRows.length
        ) {
            return false;
        }
        const removeAt = target;
        const lines = (toMarkdown(table_) || "").split("\n");
        lines.splice(2 + removeAt, 1);
        const bodyLeft = bodyRows.length - 1;
        const cursorLine =
            bodyLeft > 0 ? 2 + Math.min(removeAt, bodyLeft - 1) : 0;
        lines[cursorLine] = this._injectCursorAtFirstCell_(lines[cursorLine]);
        this.chainProduceParsedData_((chain) => {
            chain.replaceTopLevelSlice_(index_, 1, lines.join("\n"), true);
        });
        return true;
    }

    /**
     * Structural table op: delete a column. `colIndex` = 0-based; omitted →
     * inferred from `tableUuid` (the column of the cell containing that
     * uuid). The last remaining column cannot be deleted (returns false).
     * The caret lands in the header cell that takes the deleted slot.
     */
    public deleteTableColumn(tableUuid: string, colIndex?: number): boolean {
        this.applyPendingText_();
        const located = this._locateTopLevelTable_(tableUuid);
        if (!located) return false;
        const { index_, table_ } = located;
        const cols =
            table_.children_?.[0]?.children_?.[0]?.children_?.length || 0;
        // A table cannot lose its only column.
        if (cols <= 1) return false;
        let target = colIndex;
        if (target === undefined) {
            target = this._findTableColumnOf_(table_, tableUuid);
        }
        if (!Number.isInteger(target) || target < 0 || target >= cols) {
            return false;
        }
        const removeAt = target;
        const caretCol = Math.min(removeAt, cols - 2);
        const lines = (toMarkdown(table_) || "").split("\n");
        const newLines = lines.map((line, i) => {
            const hasLeading = line.startsWith("|");
            const hasTrailing = line.length > 1 && line.endsWith("|");
            if (!hasLeading || !hasTrailing) return line; // autofill row
            // Bare-pipe split + trim — parse-equivalent cell texts (padding
            // is serialization scaffolding, renormalized on reparse).
            const rowCells = line
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim());
            if (removeAt < rowCells.length) rowCells.splice(removeAt, 1);
            if (i === 0 && caretCol < rowCells.length) {
                rowCells[caretCol] = CursorMarker + rowCells[caretCol];
            }
            return `| ${rowCells.join(" | ")} |`;
        });
        this.chainProduceParsedData_((chain) => {
            chain.replaceTopLevelSlice_(index_, 1, newLines.join("\n"), true);
        });
        return true;
    }

    public insertImage(url: string, altText?: string) {
        if (!this.startCursorInfo) {
            const cursorInfo = getCursorInfoByParseData(
                this.state.renderData_.children_.at(-1),
            );
            if (cursorInfo) {
                this.setCursorInfo_(cursorInfo);
            }
        }
        const startCursorInfo = this.startCursorInfo;
        if (startCursorInfo) {
            this.chainProduceParsedData_((chain) => {
                chain.insertImage_(
                    startCursorInfo,
                    url,
                    altText || url.split(".").at(-1) || "image",
                    true,
                );
            });
        }
    }

    /**
     * Toggle an inline mark (bold/italic/strike/highlight) over the current
     * selection. `cursorInfos` are the selection's two ends, already adjusted
     * by the caller (event layer) via `editor.adjustCursor_`, so their offsets
     * index the block's serialized markdown.
     *
     * v1: single-block selections only (both ends share a render id). The
     * add-vs-strip direction is detected here on the tree (fully marked →
     * strip, otherwise add), then the work is delegated to the chain.
     */
    public format(mark: InlineFormatMark, cursorInfos?: CursorInfo[]) {
        // Toolbar-friendly default: no explicit cursors → the current MODEL
        // selection. It survives the editor losing DOM focus to a toolbar
        // click (selectionchange outside the editor is ignored), which is
        // exactly why the state-first surface works for dropdown UIs.
        if (!cursorInfos) {
            const start = this.startCursorInfo;
            if (!start) return;
            const end = this.endCursorInfo_;
            cursorInfos = end ? [start, end] : [start];
        }
        // Highlight is delimiter-driven (`==`), which is now a rule, not a
        // builtin. If the host replaced inlineRules without a `==` rule, the
        // toggle would write delimiters the parser no longer recognizes —
        // no-op instead of silently producing literal `==` in the document.
        if (mark === "highlight" && !this._inlineRules_.hasHighlight_) {
            console.warn(
                "[do-md] format('highlight') ignored: no `==` inline rule is registered (see inlineRules / defaultInlineRules)",
            );
            return;
        }
        if (!cursorInfos.length || cursorInfos.length > 2) return;

        // Collapsed caret, three-way toggle — all gated by the same
        // derivation the UI binds to (`formatState[mark].can` stays a
        // guarantee, not a hint):
        //   armed here      → disarm;
        //   active in text  → EXIT the construct at its tail;
        //   otherwise       → ARM for the next insertion (nothing written;
        //     insertText / IME compositionend wrap the text in delimiters,
        //     so no literal `****` ever appears in either mode).
        const collapsed =
            cursorInfos.length === 1 ||
            (cursorInfos[0].uuid === cursorInfos[1].uuid &&
                cursorInfos[0].offset === cursorInfos[1].offset);
        if (collapsed) {
            const cur = cursorInfos[0];
            const armed = this._pendingMarksAt_(cur) ?? [];

            // Already armed → clicking again disarms it (toggle).
            if (armed.includes(mark)) {
                return this._setPendingMarks_(
                    cur,
                    armed.filter((m) => m !== mark),
                );
            }

            const st = computeFormatState(
                this.renderData_,
                cur,
                null,
                this._inlineRules_.hasHighlight_,
            );
            if (!st[mark].can) return;

            if (st[mark].active) {
                // Collapsed toggle OFF an in-text mark = EXIT the construct
                // at its tail: hop the caret past the closing symbols (zero
                // text mutation) so subsequent typing is unformatted —
                // Notion's "stop bolding". `can` gates this to the construct
                // tail; mid-content unformatting needs a selection.
                const block = getRenderDataById(cur.uuid, this.renderData_) as
                    | ParentRenderData
                    | undefined;
                if (!block) return;
                const exit = normalizeRichCursorOffset(block, cur.offset);
                if (exit > cur.offset) {
                    this.setCursorInfo_(
                        { uuid: cur.uuid, offset: exit },
                        null,
                        CursorSource.Model,
                        true, // pure cursor move — keep out of undo
                    );
                }
                return;
            }

            return this._setPendingMarks_(cur, [...armed, mark]); // arm
        }

        const [a, b] = cursorInfos;
        if (a.uuid !== b.uuid) return; // v1: same block only

        const lo = Math.min(a.offset, b.offset);
        const hi = Math.max(a.offset, b.offset);
        if (lo === hi) return; // unreachable (collapsed handled above)

        const block = getRenderDataById(a.uuid, this.renderData_) as
            | ParentRenderData
            | undefined;
        if (!block) return;

        const op = isInlineRangeFullyMarked(block, lo, hi, mark)
            ? "strip"
            : "add";

        // bold/italic share `*`; toggling across discontinuous runs can force
        // adjacent star-delimiter groups our greedy parser mis-nests. Rather
        // than write a mangled result, swallow the op (no change).
        if (inlineFormatHasStarConflict(block, lo, hi, { mark, op })) return;

        this.chainProduceParsedData_((chain) => {
            chain.formatInline_(
                [
                    { uuid: a.uuid, offset: lo },
                    { uuid: a.uuid, offset: hi },
                ],
                { mark, op },
            );
        });
    }
}

export const {
    StoreProvider: EditorStoreProvider,
    useStoreApi: useEditorStoreApi,
    useStore: useEditorStore,
} = createReactStore(EditorStore);
