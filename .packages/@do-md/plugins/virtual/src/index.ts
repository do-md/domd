/**
 * @do-md/virtual — DOM virtualization policy for the @do-md/core-react
 * editor: viewport window rendering over the kernel's render-window seam.
 *
 * Layers, DOM-free first:
 *   window   pure math: per-type height estimates refined by measurement,
 *            prefix-sum height table, overscan window computation,
 *            hysteresis, op relevance filter
 *   store    VirtualStore (zenith): attach to an editor, keep the top-level
 *            block list in sync, resolve mode/threshold into a RenderWindow,
 *            scrollToBlock / pin / force-full API
 *   binder   DOM half: scroll + resize + mutation tracking, block
 *            measurement, manual scroll anchoring, print materialization
 *   react    provider/hooks bindings + <VirtualViewport> (feeds the kernel's
 *            RenderWindowContext)
 *
 * The kernel guarantees editing correctness whatever window this package
 * computes (cursor/selection/tail blocks are force-mounted); this package
 * owns only visual fidelity and scroll performance.
 */
export {
    DEFAULT_TYPE_ESTIMATES,
    FALLBACK_ESTIMATE,
    HeightTable,
    computeWindowRange,
    opsAffectTopLevel,
    windowCovers,
} from "./window";
export type {
    BlockSummary,
    HysteresisOptions,
    OverscanOptions,
    TopLevelOp,
    WindowRange,
} from "./window";

export { DEFAULT_AUTO_THRESHOLD, VirtualStore } from "./store";
export type {
    VirtualDomDriver,
    VirtualEditor,
    VirtualState,
    VirtualizationMode,
} from "./store";

export { bindVirtualViewport, materializeForPrint } from "./binder";

export {
    VirtualStoreProvider,
    VirtualViewport,
    useVirtualStore,
    useVirtualStoreApi,
} from "./react";
