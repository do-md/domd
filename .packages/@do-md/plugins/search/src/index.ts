/**
 * @do-md/search — headless find & replace for the @do-md/core-react editor.
 *
 * Three layers, composable and framework-free:
 *   - matcher: pure VSCode-semantics text matching (case / whole word / regex,
 *     replacement expansion, preserve-case) over the markdown source.
 *   - SearchStore: a zenith store orchestrating scan / navigate / replace
 *     through the kernel's public replace family (replaceRanges,
 *     setSelection, getSelectionOffsets, resolveRanges).
 *   - highlight: CSS Custom Highlight painting of every match, anchored the
 *     way remote cursors are drawn.
 *
 * The UI on top is the consumer's: render SearchStore state, call its
 * actions, bind the painter to the editor container.
 */
export {
    compileQuery,
    findMatches,
    expandReplacement,
    preserveCase,
    DEFAULT_MATCH_LIMIT,
} from "./matcher";
export type {
    SearchOptions,
    SearchMatch,
    CompiledQuery,
    FindMatchesResult,
} from "./matcher";

export { SearchStore } from "./store";
export type {
    SearchState,
    SearchableEditor,
    RangeAnchor,
    ResolvedMatchRange,
} from "./store";

export {
    SearchStoreProvider,
    useSearchStore,
    useSearchStoreApi,
} from "./react";

export {
    bindSearchPainter,
    paintHighlights,
    clearHighlights,
    supportsHighlightPainting,
    SEARCH_HIGHLIGHT,
    SEARCH_HIGHLIGHT_ACTIVE,
} from "./highlight";
export type { PaintableEditor } from "./highlight";
