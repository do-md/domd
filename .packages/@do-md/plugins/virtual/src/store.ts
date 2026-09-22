/**
 * Headless virtualization state machine — a zenith store over the kernel's
 * public block-summary/ops surface. No React; the DOM half (scroll listener,
 * measurement, anchoring) registers itself as a driver (see ./binder), and
 * the React binding feeds `state.window` into the kernel's
 * RenderWindowContext.
 *
 * Update strategy mirrors @do-md/toc: the top-level block list is rebuilt by
 * a FULL `getTopLevelBlocks()` pull, but pulls are gated by
 * `opsAffectTopLevel` — typing inside a block touches nothing. Remote edits
 * (collaboration applies emit no ops by design — echo prevention) are caught
 * by an O(1) block-count probe on every store notification; a same-count
 * remote structural swap can leave the list stale until the next local
 * structural op — positions self-heal through measurement, and the KERNEL
 * guarantees editing correctness regardless (cursor/selection/tail blocks
 * are force-mounted whatever window this store computes).
 */
import { ZenithStore } from "@do-md/zenith";
import type { RenderWindow } from "@do-md/core-react";
import {
    HeightTable,
    computeWindowRange,
    opsAffectTopLevel,
    windowCovers,
} from "./window";
// Type-only imports stay type-only: Node's --experimental-strip-types (the
// verify harness) does no import elision — a type reached through a value
// import crashes at module init.
import type { BlockSummary, TopLevelOp } from "./window";

export type VirtualizationMode = "off" | "auto" | "always";

/** Default `auto` threshold: virtualize at/above this many top-level blocks.
 *  Measured mount cost is ~0.3ms per top-level block, so 500 blocks is the
 *  ~150ms boundary a reader cannot feel, while 2000 (the first cut) already
 *  costs ~600ms of visible hang on open. Below the threshold the editor
 *  renders every block exactly as it always has. */
export const DEFAULT_AUTO_THRESHOLD = 500;

/**
 * The slice of the kernel's EditorStore this engine consumes — structural, so
 * any store satisfying it works (and a headless kernel store in tests does
 * too). Every required member is public kernel API on kernels shipping the
 * render-window seam; the optional ones only improve behavior (nested-anchor
 * resolution, cursor follow) and degrade silently on their absence.
 */
export interface VirtualEditor {
    getTopLevelBlocks(): { rootUuid: string; blocks: BlockSummary[] };
    subscribeRenderDataOps(listener: (ops: unknown[]) => void): () => void;
    /** Zenith base subscription — the O(1) remote-edit count probe rides it. */
    subscribe(listener: () => void): () => void;
    /** Optional: O(1) top-level block count. Enables the remote-edit probe
     *  (external/collaborative applies emit no ops); without it the block
     *  list refreshes on local structural ops only. */
    getTopLevelBlockCount?(): number;
    /** Optional: local cursor stream; enables scroll-back-to-caret when an
     *  edit lands outside the window (undo far away, typing after scrolling
     *  off). */
    subscribeCursorChange?(
        listener: (cursor: {
            start: { uuid: string } | null;
            end: { uuid: string } | null;
        }) => void,
    ): () => void;
    /** Optional: nested uuid → top-level block uuid (search matches inside
     *  list items / table cells). */
    getTopLevelUuid?(uuid: string): string | null;
}

/** The imperative DOM driver the binder registers (scroll + measurement own
 *  the container; the store only owns state). */
export interface VirtualDomDriver {
    /** Scroll the container so the block at `index` enters the viewport;
     *  precise alignment happens on the post-mount pass. */
    scrollToIndex(index: number, uuid: string): void;
    /** Viewport-coordinate top of a block (mounted or not — unmounted blocks
     *  resolve through the prefix table). Null when unresolvable. */
    blockViewportTop(index: number): number | null;
    /** Ask for a fresh pass (measure + window recompute) on the next frame. */
    schedule(): void;
}

export interface VirtualState {
    /** What the kernel's RenderWindowContext consumes. Null = full render. */
    window: RenderWindow | null;
    /** True while the policy is actually windowing (mode+threshold say yes
     *  and no force-full override is active). */
    active: boolean;
    blockCount: number;
}

const PAD_EPSILON = 0.5;

/** Minimum interval between full top-level block-list pulls (ms). */
const SCAN_THROTTLE_MS = 120;

export class VirtualStore extends ZenithStore<VirtualState> {
    public readonly table = new HeightTable();

    private editor_: VirtualEditor | null = null;
    private disposers_: (() => void)[] = [];
    private rootUuid_ = "";
    private mode_: VirtualizationMode = "off";
    private threshold_ = DEFAULT_AUTO_THRESHOLD;
    /** Nested force-full requests (print materialization). */
    private forceFull_ = 0;
    /** Policy pins (public pin/unpin API), merged into the window. */
    private pins_ = new Set<string>();
    /** Last known viewport metrics (content coordinates). Kept as a fallback
     *  for headless callers; the live value comes from viewportProvider_. */
    private viewTop_ = 0;
    private viewportHeight_ = 0;
    private hasViewport_ = false;
    /**
     * PULL seam for viewport geometry. The window must always be computed
     * against where the viewport IS, not where it was when someone last
     * pushed a value: during a chunked document load the main thread is
     * saturated for seconds at a time, the binder's rAF pass is starved, and
     * every append tick would otherwise recompute the window around a stale
     * scroll position — leaving the reader parked in the spacer with nothing
     * mounted. Reading scrollTop/rects is cheap and layout-clean here (no
     * style writes happen between), so refresh_ pulls fresh geometry from the
     * binder on every recompute.
     */
    private viewportProvider_:
        | (() => { viewTop: number; height: number } | null)
        | null = null;
    /** Timestamp of the last full block-list pull (throttle anchor). */
    private lastScanAt_ = 0;
    /** Pending trailing rescan timer id (throttle tail). */
    private scanTimer_: ReturnType<typeof setTimeout> | null = null;
    private driver_: VirtualDomDriver | null = null;
    /** One-entry cursor resolution cache (typing keeps the same block). */
    private cursorCache_: { raw: string; index: number } | null = null;
    /** Diagnostic: full list pulls since attach (op-gating assertions). */
    public scanCount = 0;

    constructor() {
        super({ window: null, active: false, blockCount: 0 });
    }

    // ------------------------------------------------------------ lifecycle

    /** Wire the engine to an editor store and scan immediately. Idempotent
     *  per editor; call the returned dispose (or detach()) on unmount. */
    public attach(editor: VirtualEditor): () => void {
        if (this.editor_ === editor) return () => this.detach();
        this.detach();
        this.editor_ = editor;
        this.scanCount = 0;
        this.rescan_();
        this.disposers_.push(
            editor.subscribeRenderDataOps((ops) => {
                if (opsAffectTopLevel(ops as TopLevelOp[], this.rootUuid_)) {
                    this.requestRescan_();
                }
            }),
        );
        // Remote-edit fallback: collaboration applies emit no ops (echo
        // prevention), but they do notify subscribers — an O(1) count probe
        // catches every insert/delete they cause. A same-count structural
        // swap stays stale until the next local structural op (documented
        // degradation; the kernel's forced pins keep editing correct).
        if (editor.getTopLevelBlockCount) {
            this.disposers_.push(
                editor.subscribe(() => this.probeCount_()),
            );
        }
        if (editor.subscribeCursorChange) {
            this.disposers_.push(
                editor.subscribeCursorChange((cursor) => {
                    this.followCursor_(cursor.start?.uuid ?? null);
                }),
            );
        }
        this.refresh_();
        return () => this.detach();
    }

    public detach(): void {
        for (const dispose of this.disposers_) dispose();
        this.disposers_ = [];
        if (this.scanTimer_ !== null) {
            clearTimeout(this.scanTimer_);
            this.scanTimer_ = null;
        }
        this.editor_ = null;
        this.rootUuid_ = "";
        this.cursorCache_ = null;
        this.table.setBlocks([]);
        if (this.state.window !== null || this.state.active) {
            this.produce((draft) => {
                draft.window = null;
                draft.active = false;
                draft.blockCount = 0;
            });
        }
    }

    /** Runtime configuration; re-resolves activation immediately. */
    public configure(options: {
        mode?: VirtualizationMode;
        threshold?: number;
    }): void {
        if (options.mode !== undefined) this.mode_ = options.mode;
        if (options.threshold !== undefined && options.threshold > 0) {
            this.threshold_ = options.threshold;
        }
        this.refresh_(true);
    }

    public get mode(): VirtualizationMode {
        return this.mode_;
    }

    // ------------------------------------------------------------ DOM seam

    /** The binder registers itself here (and unregisters with null). */
    public attachDomDriver(driver: VirtualDomDriver | null): void {
        this.driver_ = driver;
    }

    /**
     * Register the live viewport source (see viewportProvider_). Every window
     * recompute — whoever triggers it, on whatever frame — asks this for the
     * CURRENT scroll position, so a starved rAF pass can never pin the window
     * to a stale viewport. Pass null to unregister.
     */
    public attachViewportProvider(
        provider: (() => { viewTop: number; height: number } | null) | null,
    ): void {
        this.viewportProvider_ = provider;
        if (provider) this.refresh_();
    }

    /** Recompute the window against the live viewport. The binder calls this
     *  straight from the scroll event — synchronously, before any frame — so
     *  scrolling keeps working while the main thread is too busy for rAF. */
    public syncViewport(): void {
        this.refresh_();
    }

    /** Viewport metrics from the binder: `viewTop` is the viewport's top in
     *  content coordinates (px from the editor root's top). */
    public setViewport(viewTop: number, viewportHeight: number): void {
        this.viewTop_ = viewTop;
        this.viewportHeight_ = viewportHeight;
        this.hasViewport_ = viewportHeight > 0;
        this.refresh_();
    }

    /** Batch of fresh measurements from the binder. Returns true when any
     *  offset changed (the binder then anchors the scroll position). */
    public recordHeights(
        entries: { uuid: string; height: number; type?: string }[],
    ): boolean {
        let changed = false;
        for (const entry of entries) {
            if (this.table.record(entry.uuid, entry.height, entry.type)) {
                changed = true;
            }
        }
        if (changed) this.refresh_(true);
        return changed;
    }

    // ------------------------------------------------------------ public API

    /** Scroll the editor so the block hosting `uuid` (top-level or nested)
     *  enters the viewport. False when the uuid cannot be resolved or no DOM
     *  is bound. No-op scroll when virtualization is inactive — callers keep
     *  their own scrollIntoView path for the mounted-DOM case. */
    public scrollToBlock(uuid: string): boolean {
        if (!this.driver_) return false;
        const index = this.resolveIndex_(uuid);
        if (index === null) return false;
        this.driver_.scrollToIndex(index, this.table.blocks[index].uuid);
        return true;
    }

    /** Viewport-coordinate top edge of the block hosting `uuid` — the same
     *  number `getBoundingClientRect().top` reports for mounted blocks, but
     *  answered from the height table so it works for unmounted ones too
     *  (TOC scroll-spy). Null when unresolvable. */
    public blockViewportTop(uuid: string): number | null {
        if (!this.driver_) return null;
        const index = this.resolveIndex_(uuid);
        if (index === null) return null;
        return this.driver_.blockViewportTop(index);
    }

    /** Keep a block mounted regardless of the window (external decorations).
     *  Returns the unpin dispose. */
    public pin(uuid: string): () => void {
        this.pins_.add(uuid);
        this.refresh_(true);
        return () => this.unpin(uuid);
    }

    public unpin(uuid: string): void {
        if (this.pins_.delete(uuid)) this.refresh_(true);
    }

    /** Force-full override (print/export materialization): while any holder
     *  is active the window is null and every block mounts. Counted, so
     *  nested holders compose. */
    public setForceFull(on: boolean): void {
        this.forceFull_ = Math.max(0, this.forceFull_ + (on ? 1 : -1));
        this.refresh_(true);
    }

    // ------------------------------------------------------------ internals

    /**
     * Coalesced entry point for "the top-level block list may have changed".
     * A chunked document load emits one structural op batch per idle tick
     * (hundreds of them), and every full pull allocates a summary per block —
     * O(n) each, O(n^2) over a load, which is a large part of what starves the
     * main thread in the first place. Throttling to one pull per
     * SCAN_THROTTLE_MS keeps the scrollbar growing smoothly (~8 updates/s) at
     * a fraction of the cost, with a trailing pull so the final state is never
     * stale. Correctness is unaffected: a momentarily short block list only
     * shortens the scroll range, and the kernel force-mounts cursor/selection/
     * tail blocks regardless of the window this store computes.
     */
    private requestRescan_(): void {
        const now = Date.now();
        const elapsed = now - this.lastScanAt_;
        if (elapsed >= SCAN_THROTTLE_MS) {
            this.rescan_();
            return;
        }
        if (this.scanTimer_ !== null) return;
        this.scanTimer_ = setTimeout(() => {
            this.scanTimer_ = null;
            if (this.editor_) this.rescan_();
        }, SCAN_THROTTLE_MS - elapsed);
    }

    private rescan_(): void {
        const editor = this.editor_;
        if (!editor) return;
        this.scanCount += 1;
        this.lastScanAt_ = Date.now();
        const { rootUuid, blocks } = editor.getTopLevelBlocks();
        this.rootUuid_ = rootUuid;
        this.table.setBlocks(blocks);
        this.cursorCache_ = null;
        this.refresh_(true);
    }

    /** O(1) probe for remote structural edits (no ops emitted): a top-level
     *  count change forces a full rescan. */
    private probeCount_(): void {
        const editor = this.editor_;
        if (!editor?.getTopLevelBlockCount) return;
        if (editor.getTopLevelBlockCount() !== this.table.blockCount) {
            this.requestRescan_();
        }
    }

    private resolveIndex_(uuid: string): number | null {
        const blocks = this.table.blocks;
        for (let i = 0; i < blocks.length; i++) {
            if (blocks[i].uuid === uuid) return i;
        }
        // Nested anchor (span inside a list item, a table cell...) — ask the
        // kernel for the top-level ancestor, then find it flat.
        const topUuid = this.editor_?.getTopLevelUuid?.(uuid) ?? null;
        if (topUuid && topUuid !== uuid) {
            for (let i = 0; i < blocks.length; i++) {
                if (blocks[i].uuid === topUuid) return i;
            }
        }
        return null;
    }

    /** Scroll back to the caret when the cursor's block leaves the window —
     *  an edit landed outside (undo far away, typing after scrolling off).
     *  Clicking can only target mounted DOM, so a click never triggers it. */
    private followCursor_(uuid: string | null): void {
        if (!uuid || !this.state.active || !this.driver_) return;
        const window = this.state.window;
        if (!window) return;
        let index: number | null;
        if (this.cursorCache_ && this.cursorCache_.raw === uuid) {
            index = this.cursorCache_.index;
            // Validate: the list may have shifted under the cache.
            const block = this.table.blocks[index];
            if (!block || block.uuid !== uuid) {
                this.cursorCache_ = null;
                index = this.resolveIndex_(uuid);
            }
        } else {
            index = this.resolveIndex_(uuid);
        }
        if (index === null) return;
        this.cursorCache_ = { raw: uuid, index };
        if (index < window.startIndex || index >= window.endIndex) {
            this.driver_.scrollToIndex(index, this.table.blocks[index].uuid);
        }
    }

    /** Recompute activation + window. `force` skips the hysteresis (list,
     *  heights, pins or config changed — pads must be honest even when the
     *  index range holds). */
    private refresh_(force = false): void {
        const blockCount = this.table.blockCount;
        const active =
            this.forceFull_ === 0 &&
            this.editor_ !== null &&
            (this.mode_ === "always" ||
                (this.mode_ === "auto" && blockCount >= this.threshold_));
        if (!active) {
            if (
                this.state.window !== null ||
                this.state.active ||
                this.state.blockCount !== blockCount
            ) {
                this.produce((draft) => {
                    draft.window = null;
                    draft.active = false;
                    draft.blockCount = blockCount;
                });
            }
            return;
        }
        // Live geometry wins over the last pushed value (see
        // viewportProvider_); the pushed value is the headless fallback.
        const live = this.viewportProvider_?.() ?? null;
        if (live && live.height > 0) {
            this.viewTop_ = live.viewTop;
            this.viewportHeight_ = live.height;
            this.hasViewport_ = true;
        }
        const viewportHeight = this.hasViewport_ ? this.viewportHeight_ : 800;
        const current = this.state.window;
        if (
            !force &&
            current &&
            windowCovers(this.table, current, this.viewTop_, viewportHeight)
        ) {
            return;
        }
        const range = computeWindowRange(
            this.table,
            this.viewTop_,
            viewportHeight,
        );
        if (!range) {
            if (this.state.window !== null) {
                this.produce((draft) => {
                    draft.window = null;
                    draft.active = true;
                    draft.blockCount = blockCount;
                });
            }
            return;
        }
        const pinned = this.pins_.size ? Array.from(this.pins_) : undefined;
        const unchanged =
            current !== null &&
            this.state.active &&
            this.state.blockCount === blockCount &&
            current.startIndex === range.startIndex &&
            current.endIndex === range.endIndex &&
            Math.abs(current.topPad - range.topPad) < PAD_EPSILON &&
            Math.abs(current.bottomPad - range.bottomPad) < PAD_EPSILON &&
            samePins(current.pinnedUuids, pinned);
        if (unchanged) return;
        this.produce((draft) => {
            draft.window = {
                startIndex: range.startIndex,
                endIndex: range.endIndex,
                topPad: range.topPad,
                bottomPad: range.bottomPad,
                ...(pinned ? { pinnedUuids: pinned } : {}),
            };
            draft.active = true;
            draft.blockCount = blockCount;
        });
        this.driver_?.schedule();
    }
}

const samePins = (
    a: readonly string[] | undefined,
    b: readonly string[] | undefined,
): boolean => {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};
