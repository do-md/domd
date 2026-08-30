/**
 * Headless find & replace state machine — a zenith store over the kernel's
 * public editing surface. No React, no DOM: the UI layer renders this state
 * and calls these actions; painting lives in ./highlight.
 *
 * Design decisions (VSCode find-widget parity, adapted to a WYSIWYG host):
 *
 * - SEARCH SPACE IS THE MARKDOWN SOURCE — the same `toMarkdown()` space the
 *   kernel's replace family addresses, so every match range feeds
 *   `replaceRanges` / `resolveRanges` verbatim. A phrase spanning a formatting
 *   marker (`hello **world**`) does not match "hello world", exactly like
 *   source-space find in Obsidian's live preview.
 *
 * - NAVIGATION NEVER MOVES THE REAL SELECTION. The current match is painted
 *   as a decoration (CSS Custom Highlight), not selected — moving the model
 *   selection while the find input holds focus would fight the input for the
 *   document selection and broadcast presence noise to collaborators. The
 *   model selection is placed once, on close(), so dismissing the widget
 *   leaves the caret at the current match (VSCode's Escape behavior).
 *
 * - REPLACE ALL IS ONE `replaceRanges` CALL — the kernel folds the batch into
 *   a single undo step and fine-grained collab ops; per-match regex group
 *   expansion and preserve-case are computed here, from groups captured at
 *   scan time.
 */
import { ZenithStore } from "@do-md/zenith";
import {
    CompiledQuery,
    DEFAULT_MATCH_LIMIT,
    SearchMatch,
    SearchOptions,
    compileQuery,
    expandReplacement,
    findMatches,
    preserveCase,
} from "./matcher";

/** One resolved endpoint: block uuid + in-block text offset (the kernel's
 *  CursorSnapshot vocabulary). Typed structurally so this package compiles
 *  against kernels that predate resolveRanges. */
export interface RangeAnchor {
    uuid: string;
    offset: number;
}

export interface ResolvedMatchRange {
    start: RangeAnchor;
    end: RangeAnchor;
}

/**
 * The slice of the kernel's EditorStore this engine consumes — structural,
 * so any store satisfying it works and older kernels degrade gracefully:
 * `resolveRanges` (kernel >=0.11.7) is optional and only gates highlight
 * painting, never search/replace itself.
 */
export interface SearchableEditor {
    toMarkdown(): string;
    setSelection(target: { start: number; end?: number }): {
        applied: boolean;
    };
    replaceRanges(
        ...edits: { start: number; end: number; text: string }[]
    ): unknown;
    getSelectionOffsets(): { start: number; end: number } | null;
    subscribeRenderDataOps(listener: (ops: unknown[]) => void): () => void;
    /** Optional: feeds the open-with-selection prefill (VSCode's ⌘F). */
    getSelectionState?(): { selected_text: string };
    resolveRanges?(
        ...ranges: { start: number; end: number }[]
    ): (ResolvedMatchRange | null)[];
}

export interface SearchState {
    /** Widget visibility. Closed = no scanning, no highlights. */
    open: boolean;
    /** Replace row expanded (the chevron / ⌥⌘F state). */
    replaceExpanded: boolean;
    query: string;
    replacement: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
    preserveCase: boolean;
    matches: SearchMatch[];
    /** Index into `matches`; -1 when there is no match. */
    activeIndex: number;
    /** Regex parse error (regex mode only) — render the input invalid. */
    queryError: string | null;
    /** The scan stopped at the match limit; the count is a floor, not exact. */
    limitHit: boolean;
}

const INITIAL_STATE: SearchState = {
    open: false,
    replaceExpanded: false,
    query: "",
    replacement: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    preserveCase: false,
    matches: [],
    activeIndex: -1,
    queryError: null,
    limitHit: false,
};

export class SearchStore extends ZenithStore<SearchState> {
    private editor_: SearchableEditor | null = null;
    private unsubscribeOps_: (() => void) | null = null;

    constructor() {
        super(INITIAL_STATE);
    }

    /** Wire the engine to an editor store. Idempotent per editor; call the
     *  returned dispose (or detach()) when the editor unmounts. */
    public attach(editor: SearchableEditor): () => void {
        if (this.editor_ === editor) return () => this.detach();
        this.detach();
        this.editor_ = editor;
        // Document edits (local typing, collab ops, AI edits) invalidate the
        // scanned offsets — rescan while the widget is open. The active match
        // is re-anchored to the nearest offset, so the widget does not jump
        // to the first match on every keystroke.
        this.unsubscribeOps_ = editor.subscribeRenderDataOps(() => {
            if (this.state.open) this.rescan_({ keepNear: true });
        });
        return () => this.detach();
    }

    public detach() {
        this.unsubscribeOps_?.();
        this.unsubscribeOps_ = null;
        this.editor_ = null;
        this.produce((draft) => {
            Object.assign(draft, INITIAL_STATE);
        });
    }

    /** Resolve current matches to block anchors for highlight painting.
     *  Empty on kernels without resolveRanges (paint nothing, everything
     *  else still works). `limit` caps the resolution cost on huge match
     *  sets — the painter cannot show 20k highlights usefully anyway. */
    public resolveMatchAnchors(
        limit: number = 1000,
    ): (ResolvedMatchRange | null)[] {
        const editor = this.editor_;
        if (!editor?.resolveRanges) return [];
        const { matches, activeIndex } = this.state;
        if (matches.length === 0) return [];
        const capped = matches.slice(0, limit);
        // The active match must always be resolvable, even beyond the cap.
        if (activeIndex >= limit) capped.push(matches[activeIndex]);
        return editor.resolveRanges(
            ...capped.map(({ start, end }) => ({ start, end })),
        );
    }

    // ================================================================
    // Widget lifecycle
    // ================================================================

    /**
     * The editor's current selection when it makes a sensible query seed —
     * single line, non-empty, sane length (VSCode's prefill rule). Undefined
     * otherwise, so the previous query survives reopening.
     */
    private selectionPrefill_(): string | undefined {
        const text = this.editor_?.getSelectionState?.().selected_text;
        if (!text || text.includes("\n") || text.length > 1000) {
            return undefined;
        }
        return text;
    }

    /**
     * Open the widget (⌘F, or the top-bar menu entry — same call, same
     * semantics). A single-line editor selection prefills the query,
     * VSCode-style; otherwise the previous query is kept and re-scanned. The
     * active match starts at the first match at or after the caret.
     */
    public openFind() {
        const prefill = this.selectionPrefill_();
        this.produce((draft) => {
            draft.open = true;
            if (prefill) {
                draft.query = prefill;
                draft.queryError = null;
            }
        });
        this.rescan_({ fromCursor: true });
    }

    /** Open with the replace row expanded (⌥⌘F / Ctrl+H). */
    public openReplace() {
        this.produce((draft) => {
            draft.replaceExpanded = true;
        });
        this.openFind();
    }

    public toggleReplaceExpanded() {
        this.produce((draft) => {
            draft.replaceExpanded = !draft.replaceExpanded;
        });
    }

    /**
     * Close the widget and land the model selection on the current match, so
     * the caret ends up where the user was looking (VSCode's Escape). The
     * app layer refocuses the editor.
     */
    public close() {
        const { matches, activeIndex } = this.state;
        const active = activeIndex >= 0 ? matches[activeIndex] : undefined;
        this.produce((draft) => {
            draft.open = false;
            draft.replaceExpanded = false;
            draft.matches = [];
            draft.activeIndex = -1;
            draft.limitHit = false;
        });
        if (active && this.editor_) {
            this.editor_.setSelection({ start: active.start, end: active.end });
        }
    }

    // ================================================================
    // Query / options
    // ================================================================

    public setQuery(query: string) {
        this.produce((draft) => {
            draft.query = query;
        });
        this.rescan_({ fromCursor: true });
    }

    public setReplacement(replacement: string) {
        this.produce((draft) => {
            draft.replacement = replacement;
        });
    }

    public setOption(option: keyof SearchOptions | "preserveCase", value: boolean) {
        this.produce((draft) => {
            draft[option] = value;
        });
        if (option !== "preserveCase") this.rescan_({ keepNear: true });
    }

    // ================================================================
    // Navigation — decoration-only, see the header note
    // ================================================================

    public findNext() {
        this.step_(1);
    }

    public findPrevious() {
        this.step_(-1);
    }

    private step_(direction: 1 | -1) {
        const { matches, activeIndex } = this.state;
        if (matches.length === 0) return;
        const next =
            activeIndex < 0
                ? direction === 1
                    ? 0
                    : matches.length - 1
                : (activeIndex + direction + matches.length) % matches.length;
        this.produce((draft) => {
            draft.activeIndex = next;
        });
    }

    // ================================================================
    // Replace
    // ================================================================

    /** Replacement text for one match, honoring regex groups + preserve-case. */
    private replacementFor_(match: SearchMatch, docText: string): string {
        const { regex, replacement } = this.state;
        let text = regex ? expandReplacement(replacement, match) : replacement;
        if (this.state.preserveCase) {
            text = preserveCase(docText.slice(match.start, match.end), text);
        }
        return text;
    }

    /**
     * Replace the current match and advance to the next one (VSCode's
     * replace button). One kernel call, one undo step; the ops subscription
     * rescans, then the active match re-anchors to the replacement's end.
     */
    public replaceCurrent() {
        const editor = this.editor_;
        const { matches, activeIndex } = this.state;
        if (!editor || activeIndex < 0) return;
        const match = matches[activeIndex];
        if (!match) return;
        const docText = editor.toMarkdown();
        const text = this.replacementFor_(match, docText);
        editor.replaceRanges({ start: match.start, end: match.end, text });
        // The ops subscription has already rescanned synchronously. Advance
        // past the inserted text (VSCode semantics), so a replacement that
        // matches the query itself ("a" -> "aa") does not trap the cursor.
        this.activateAtOrAfter_(match.start + text.length);
    }

    /** Replace every match in ONE replaceRanges call — a single undo step. */
    public replaceAll() {
        const editor = this.editor_;
        const { matches } = this.state;
        if (!editor || matches.length === 0) return;
        const docText = editor.toMarkdown();
        editor.replaceRanges(
            ...matches.map((match) => ({
                start: match.start,
                end: match.end,
                text: this.replacementFor_(match, docText),
            })),
        );
    }

    // ================================================================
    // Scanning
    // ================================================================

    private compile_(): CompiledQuery {
        const { query, caseSensitive, wholeWord, regex } = this.state;
        return compileQuery(query, { caseSensitive, wholeWord, regex });
    }

    /**
     * Recompute matches against the current document.
     * `fromCursor`: activate the first match at/after the caret (open, query
     * edits). `keepNear`: re-anchor to the previous active offset (document
     * edits, option toggles).
     */
    private rescan_(anchor: { fromCursor?: boolean; keepNear?: boolean }) {
        const editor = this.editor_;
        if (!editor || !this.state.open) return;
        const previousActive =
            this.state.activeIndex >= 0
                ? this.state.matches[this.state.activeIndex]?.start
                : undefined;
        const compiled = this.compile_();
        const { caseSensitive, wholeWord, regex } = this.state;
        const scan =
            compiled.kind === "ok"
                ? findMatches(
                      editor.toMarkdown(),
                      compiled,
                      { caseSensitive, wholeWord, regex },
                      DEFAULT_MATCH_LIMIT,
                  )
                : { matches: [], limitHit: false };
        this.produce((draft) => {
            draft.matches = scan.matches;
            draft.limitHit = scan.limitHit;
            draft.queryError =
                compiled.kind === "error" ? compiled.message : null;
            draft.activeIndex = -1;
        });
        if (scan.matches.length === 0) return;
        if (anchor.keepNear && previousActive !== undefined) {
            this.activateAtOrAfter_(previousActive);
        } else if (anchor.fromCursor) {
            const offsets = editor.getSelectionOffsets();
            this.activateAtOrAfter_(offsets ? offsets.start : 0);
        } else {
            this.activateAtOrAfter_(0);
        }
    }

    /** Activate the first match starting at/after `offset`, wrapping to the
     *  first match when none follows. */
    private activateAtOrAfter_(offset: number) {
        const { matches } = this.state;
        if (matches.length === 0) return;
        let index = matches.findIndex((match) => match.start >= offset);
        if (index === -1) index = 0;
        this.produce((draft) => {
            draft.activeIndex = index;
        });
    }
}
