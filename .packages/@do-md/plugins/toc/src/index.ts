/**
 * @do-md/toc — headless document outline (table of contents) for the
 * @do-md/core-react editor.
 *
 * Layers, DOM-free first:
 *   outline  pure extraction: serialized snapshot → flat heading list
 *            ({uuid, level, depth, text}) + the op relevance filter
 *   store    TocStore (zenith): attach to an editor, keep the outline in
 *            sync with the op stream, hold the scroll-spy result
 *   spy      DOM binder: scroll spy over the editor's scroll container +
 *            click-to-jump via the block uuid DOM contract
 *   react    provider/hooks bindings (zenith createReactStore)
 */
export {
    buildOutline,
    headingText,
    isHeadingType,
    opsAffectOutline,
    outlineEquals,
} from "./outline";
export type {
    OutlineIndex,
    OutlineNode,
    OutlineOp,
    TocHeading,
} from "./outline";

export { TocStore } from "./store";
export type { TocEditor, TocState } from "./store";

export { bindTocSpy, scrollToHeading } from "./spy";
export type { TocSpyOptions } from "./spy";

export { TocStoreProvider, useTocStore, useTocStoreApi } from "./react";
