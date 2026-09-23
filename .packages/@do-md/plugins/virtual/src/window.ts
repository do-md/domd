/**
 * Pure window math — no DOM, no React, no kernel import. Everything here is
 * typed structurally against the kernel's public `getTopLevelBlocks()` shape
 * and the stable op-stream keys, so the package compiles against any kernel
 * providing that contract. The DOM half (scroll listener, measurement,
 * anchoring) lives in ./binder; the state machine in ./store.
 *
 * Height model (the react-window / CodeMirror-6 measurement-cache technique,
 * adapted to model-identity blocks):
 * - every top-level block has a height: MEASURED once its DOM has been seen
 *   (recorded by uuid, so it survives list rebuilds), otherwise ESTIMATED
 *   from its block type — a static per-type table refined by the running
 *   average of real measurements of that type (self-tuning; kernel types
 *   that render nothing — blank-line scaffolding — estimate 0 and never get
 *   measured);
 * - a lazily rebuilt prefix-sum array turns heights into offsets and back
 *   (binary search), which is what the window computation, the spacer pads,
 *   scrollToBlock and the TOC spy all consume.
 */

/** One top-level block, as the kernel's `getTopLevelBlocks()` reports it. */
export interface BlockSummary {
    uuid: string;
    type: string;
    isAutoFill: boolean;
}

/** The computed window in block indexes + spacer pads (px). Mirrors the
 *  kernel's RenderWindow minus pinnedUuids (the store merges pins in). */
export interface WindowRange {
    startIndex: number;
    /** Exclusive. */
    endIndex: number;
    topPad: number;
    bottomPad: number;
}

/** Static per-type height estimates (px) for never-measured blocks. The
 *  zero entries are the kernel's non-rendered scaffolding (NonRenderedElements)
 *  — they produce no DOM and must contribute no height. Unknown types fall
 *  back to FALLBACK_ESTIMATE. */
export const DEFAULT_TYPE_ESTIMATES: Record<string, number> = {
    P: 28,
    EmptyP: 28,
    LineBr: 0,
    LineBrBr: 0,
    MdHideSymbol: 0,
    OlListSymbol: 0,
    UlListSymbol: 0,
    H1: 48,
    H2: 40,
    H3: 34,
    H4: 32,
    H5: 30,
    H6: 28,
    Pre: 160,
    PreEmpty: 48,
    Table: 140,
    Blockquote: 72,
    Ul: 88,
    Ol: 88,
    // The kernel renders a horizontal rule as an `HrDiv` block; `Hr` is the
    // inner element and never appears in the top-level summary, so the
    // estimate has to be keyed by what getTopLevelBlocks() actually reports.
    HrDiv: 29,
    Hr: 29,
    Img: 220,
    ImgGroup: 220,
};

export const FALLBACK_ESTIMATE = 32;

/** Measurements within this tolerance of the stored value are ignored —
 *  sub-pixel rect jitter must not invalidate the prefix table every frame. */
const HEIGHT_EPSILON = 0.5;

/** Samples needed before a type's running average replaces its static
 *  estimate. */
const TUNE_MIN_SAMPLES = 4;

export class HeightTable {
    private blocks_: BlockSummary[] = [];
    /** uuid → index into blocks_. Maintained by setBlocks so every consumer
     *  (scroll-spy geometry, cursor following, scrollToBlock) resolves a
     *  block in O(1) instead of scanning: the TOC spy asks per heading on
     *  every scroll frame, which was O(headings × blocks) — seconds per frame
     *  with an outline open on a 10MB document. */
    private index_ = new Map<string, number>();
    /** Measured heights by uuid — survives block-list rebuilds. */
    private measured_ = new Map<string, number>();
    /** Per-type running stats over first-time measurements (self-tuning). */
    private typeStats_ = new Map<string, { sum: number; count: number }>();
    /** prefix_[i] = sum of heights of blocks [0, i); length blockCount + 1. */
    private prefix_: number[] | null = null;
    /** Lowest index whose height changed since the prefix was built; the next
     *  read patches from here instead of rebuilding all of it. Infinity = the
     *  prefix is current. */
    private prefixDirtyFrom_ = Infinity;

    public get blockCount(): number {
        return this.blocks_.length;
    }

    public get blocks(): readonly BlockSummary[] {
        return this.blocks_;
    }

    /** Swap in a fresh top-level block list (structural change). Measured
     *  heights carry over by uuid; measurements for uuids that left the
     *  document are dropped, so a long editing session cannot accumulate a
     *  map of every block that ever existed. */
    public setBlocks(blocks: BlockSummary[]): void {
        this.blocks_ = blocks;
        this.index_ = new Map();
        for (let i = 0; i < blocks.length; i++) {
            this.index_.set(blocks[i].uuid, i);
        }
        if (this.measured_.size > blocks.length) {
            const kept = new Map<string, number>();
            for (const block of blocks) {
                const height = this.measured_.get(block.uuid);
                if (height !== undefined) kept.set(block.uuid, height);
            }
            this.measured_ = kept;
        }
        this.prefix_ = null;
        this.prefixDirtyFrom_ = Infinity;
    }

    /** Index of the block with this uuid, or -1. O(1). */
    public indexOfUuid(uuid: string): number {
        const index = this.index_.get(uuid);
        return index === undefined ? -1 : index;
    }

    public estimateFor(type: string): number {
        const stats = this.typeStats_.get(type);
        if (stats && stats.count >= TUNE_MIN_SAMPLES) {
            return stats.sum / stats.count;
        }
        const preset = DEFAULT_TYPE_ESTIMATES[type];
        return preset !== undefined ? preset : FALLBACK_ESTIMATE;
    }

    public heightOf(index: number): number {
        const block = this.blocks_[index];
        if (!block) return 0;
        const measured = this.measured_.get(block.uuid);
        return measured !== undefined ? measured : this.estimateFor(block.type);
    }

    /** Record a real measurement. Returns true when the table changed (i.e.
     *  offsets downstream of this block moved). */
    public record(uuid: string, height: number, type?: string): boolean {
        const previous = this.measured_.get(uuid);
        if (previous !== undefined && Math.abs(previous - height) < HEIGHT_EPSILON) {
            return false;
        }
        if (previous === undefined && type !== undefined) {
            const stats = this.typeStats_.get(type) ?? { sum: 0, count: 0 };
            stats.sum += height;
            stats.count += 1;
            this.typeStats_.set(type, stats);
        }
        this.measured_.set(uuid, height);
        // Only offsets AFTER this block move: remember the earliest one and
        // patch the prefix from there on the next read.
        const index = this.index_.get(uuid);
        if (index === undefined) {
            this.prefix_ = null;
            this.prefixDirtyFrom_ = Infinity;
        } else if (index < this.prefixDirtyFrom_) {
            this.prefixDirtyFrom_ = index;
        }
        return true;
    }

    public isMeasured(uuid: string): boolean {
        return this.measured_.has(uuid);
    }

    private ensurePrefix_(): number[] {
        const n = this.blocks_.length;
        if (this.prefix_ && this.prefixDirtyFrom_ === Infinity) {
            return this.prefix_;
        }
        if (this.prefix_ && this.prefix_.length === n + 1) {
            // Incremental patch: heights before the dirty index are unchanged,
            // so only the tail of the running sum needs recomputing.
            const prefix = this.prefix_;
            for (let i = this.prefixDirtyFrom_; i < n; i++) {
                prefix[i + 1] = prefix[i] + this.heightOf(i);
            }
            this.prefixDirtyFrom_ = Infinity;
            return prefix;
        }
        const prefix = new Array<number>(n + 1);
        prefix[0] = 0;
        for (let i = 0; i < n; i++) {
            prefix[i + 1] = prefix[i] + this.heightOf(i);
        }
        this.prefix_ = prefix;
        this.prefixDirtyFrom_ = Infinity;
        return prefix;
    }

    /** Content offset (px) of a block's top edge; index clamps to [0, n]. */
    public offsetOf(index: number): number {
        const prefix = this.ensurePrefix_();
        const clamped = Math.min(Math.max(index, 0), prefix.length - 1);
        return prefix[clamped];
    }

    public total(): number {
        const prefix = this.ensurePrefix_();
        return prefix[prefix.length - 1];
    }

    /** Index of the block containing content offset `y`: the greatest index
     *  whose top edge is at or above `y`, clamped to a valid index. Zero when
     *  the table is empty. */
    public indexAt(y: number): number {
        const prefix = this.ensurePrefix_();
        const n = prefix.length - 1;
        if (n <= 0) return 0;
        if (y <= 0) return 0;
        if (y >= prefix[n]) return n - 1;
        // Binary search: greatest i in [0, n-1] with prefix[i] <= y.
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (prefix[mid] <= y) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
}

export interface OverscanOptions {
    /** Overscan above the viewport, in viewport heights. Scrolling up is the
     *  rarer direction — keep it lean. */
    overscanAbove?: number;
    /** Overscan below the viewport, in viewport heights. */
    overscanBelow?: number;
}

/** Compute the window for a viewport at `viewTop` (content coordinates: px
 *  from the top of the editor root) — the overscanned slice plus its pads. */
export const computeWindowRange = (
    table: HeightTable,
    viewTop: number,
    viewportHeight: number,
    options: OverscanOptions = {},
): WindowRange | null => {
    const n = table.blockCount;
    if (n === 0) return null;
    const above = viewportHeight * (options.overscanAbove ?? 1.5);
    const below = viewportHeight * (options.overscanBelow ?? 3.5);
    const startIndex = table.indexAt(viewTop - above);
    const endIndex = Math.min(
        n,
        table.indexAt(viewTop + viewportHeight + below) + 1,
    );
    return {
        startIndex,
        endIndex,
        topPad: table.offsetOf(startIndex),
        bottomPad: table.total() - table.offsetOf(endIndex),
    };
};

export interface HysteresisOptions {
    /** Minimum remaining overscan (in viewport heights) before a recompute. */
    minAbove?: number;
    minBelow?: number;
}

/** Hysteresis: true while the current window still covers the viewport with
 *  comfortable margins — the scroll handler skips the swap (and the React
 *  re-render it costs) until the margin runs thin. */
export const windowCovers = (
    table: HeightTable,
    range: { startIndex: number; endIndex: number },
    viewTop: number,
    viewportHeight: number,
    options: HysteresisOptions = {},
): boolean => {
    const minAbove = viewportHeight * (options.minAbove ?? 0.5);
    const minBelow = viewportHeight * (options.minBelow ?? 1.5);
    const n = table.blockCount;
    const topOk =
        range.startIndex <= 0 ||
        table.offsetOf(range.startIndex) <= viewTop - minAbove;
    const bottomOk =
        range.endIndex >= n ||
        table.offsetOf(range.endIndex) >=
            viewTop + viewportHeight + minBelow;
    return topOk && bottomOk;
};

/** Structural slice of the kernel's RenderDataOp union (loose on purpose:
 *  unknown op kinds must fail toward a rescan, never toward staleness). */
export interface TopLevelOp {
    op: string;
    parent?: string;
    uuid?: string;
    key?: string;
}

/**
 * Cheap relevance filter over an op batch: `false` means the batch provably
 * cannot change the TOP-LEVEL block list (the common case — typing inside a
 * block), `true` means rescan. Type-only changes of a top-level block are
 * deliberately NOT tracked (they would need a top-level uuid set per rescan):
 * a stale estimate self-corrects on measurement.
 */
export const opsAffectTopLevel = (
    ops: TopLevelOp[],
    rootUuid: string,
): boolean => {
    for (const op of ops) {
        switch (op.op) {
            case "replaceRoot":
                return true;
            case "insert":
            case "delete": {
                if (op.parent === undefined) return true;
                if (op.parent === rootUuid) return true;
                break;
            }
            case "set": {
                if (op.uuid === undefined) return true;
                if (op.uuid === rootUuid && op.key === "children") return true;
                break;
            }
            default:
                return true;
        }
    }
    return false;
};
