/**
 * Render-window plan — the pure math behind DOM virtualization.
 *
 * The kernel renders only a window of the root's top-level blocks and holds
 * the scrollbar honest with two `contentEditable=false` spacers. The POLICY
 * (which window, which pad heights) lives outside the kernel (@do-md/virtual
 * or any host); the MECHANISM (this plan + the RootElement seam) lives here,
 * because the top-level render loop is kernel-private.
 *
 * Kernel-enforced invariants (the policy layer is allowed to be dumb; editing
 * must never target DOM that does not exist):
 *   - the block holding the model cursor (either endpoint) stays mounted;
 *   - the blocks holding the LIVE DOM selection endpoints stay mounted;
 *   - the tail autofill paragraph stays mounted.
 * Forced blocks OUTSIDE the window render adjacent to the window's edges in
 * model order (above-window pins right after the top spacer, below-window
 * pins right before the bottom spacer). Their DOM order therefore matches
 * model order exactly; their VISUAL position is approximate — by definition
 * they sit outside the overscanned window, i.e. off-screen — and the spacer
 * pads are NOT adjusted for them (total scroll height may exceed the policy's
 * accounting by the pinned blocks' heights until the policy catches up).
 *
 * No window set → the render path is byte-identical to the non-virtualized
 * editor (verified by golden markup comparison in the app repo's
 * verify-virtual-window harness).
 */
import { ParentRenderData, RenderData } from "../../type";

/** The window seam value a virtualization policy provides. */
export interface RenderWindow {
    /** First rendered top-level block index (inclusive). */
    startIndex: number;
    /** One past the last rendered top-level block index (exclusive). */
    endIndex: number;
    /** Height (px) of the spacer standing in for blocks above the window. */
    topPad: number;
    /** Height (px) of the spacer standing in for blocks below the window. */
    bottomPad: number;
    /** Extra blocks the policy wants mounted regardless of the window
     *  (top-level block uuids; nested uuids resolve to their top-level
     *  ancestor). The kernel adds its own forced pins on top. */
    pinnedUuids?: readonly string[];
}

export type RenderWindowSegment =
    | { kind: "spacer"; key: "top" | "bottom"; height: number }
    | { kind: "blocks"; from: number; to: number };

const subtreeContains = (
    node: RenderData | ParentRenderData,
    uuid: string,
): boolean => {
    const stack: (RenderData | ParentRenderData)[] = [node];
    while (stack.length) {
        const current = stack.pop()!;
        if (current.uuid_ === uuid) return true;
        if (current.children_) {
            for (let i = current.children_.length - 1; i >= 0; i--) {
                stack.push(current.children_[i]);
            }
        }
    }
    return false;
};

/**
 * Index of the top-level block containing `uuid` (the block itself or any
 * descendant). Null when the uuid is not in the tree (or IS the root).
 *
 * Cost discipline: a validated `hint` (e.g. the index resolved for the same
 * uuid on the previous render) short-circuits to one subtree check — the
 * typing-in-place hot path. Otherwise a flat top-level scan handles the
 * common "cursor block is itself top-level" case before falling back to the
 * full deep scan.
 */
export const resolveTopLevelIndex = (
    root: ParentRenderData,
    uuid: string,
    hint?: number,
): number | null => {
    const children = root.children_ || [];
    if (
        hint !== undefined &&
        hint >= 0 &&
        hint < children.length &&
        subtreeContains(children[hint], uuid)
    ) {
        return hint;
    }
    for (let i = 0; i < children.length; i++) {
        if (children[i].uuid_ === uuid) return i;
    }
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.children_ && subtreeContains(child, uuid)) return i;
    }
    return null;
};

/**
 * Turn a window + resolved pinned indexes into ordered render segments:
 * top spacer (when it has height), maximal runs of rendered block indexes
 * (window range plus out-of-window pins, merged where adjacent), bottom
 * spacer. Indexes are clamped, deduplicated and sorted, so a sloppy policy
 * cannot produce out-of-order or duplicate DOM.
 */
export const computeRenderWindowPlan = (
    childCount: number,
    window: RenderWindow,
    pinnedIndexes: readonly number[],
): RenderWindowSegment[] => {
    const n = childCount;
    const start = Math.min(Math.max(Math.floor(window.startIndex), 0), n);
    const end = Math.min(Math.max(Math.floor(window.endIndex), start), n);

    const pins = Array.from(
        new Set(
            pinnedIndexes.filter(
                (i) => Number.isInteger(i) && i >= 0 && i < n,
            ),
        ),
    ).sort((a, b) => a - b);

    // Maximal runs of rendered indexes, in order: pins below the window, the
    // window itself, pins above it. Adjacent/overlapping runs merge.
    const runs: { from: number; to: number }[] = [];
    const pushRun = (from: number, to: number) => {
        if (to <= from) return;
        const last = runs[runs.length - 1];
        if (last && from <= last.to) {
            last.to = Math.max(last.to, to);
            return;
        }
        runs.push({ from, to });
    };
    for (const pin of pins) {
        if (pin < start) pushRun(pin, pin + 1);
    }
    pushRun(start, end);
    for (const pin of pins) {
        if (pin >= end) pushRun(pin, pin + 1);
    }

    const segments: RenderWindowSegment[] = [];
    if (window.topPad > 0) {
        segments.push({ kind: "spacer", key: "top", height: window.topPad });
    }
    for (const run of runs) {
        segments.push({ kind: "blocks", from: run.from, to: run.to });
    }
    if (window.bottomPad > 0) {
        segments.push({
            kind: "spacer",
            key: "bottom",
            height: window.bottomPad,
        });
    }
    return segments;
};

/**
 * Kernel-side pin resolution + plan for one render pass. `hintCache` is a
 * caller-owned uuid→index map reused across renders (validated per use, so a
 * stale entry costs one subtree check and self-heals).
 */
export const buildRenderWindowPlan = (
    root: ParentRenderData,
    window: RenderWindow,
    forcedUuids: readonly (string | null | undefined)[],
    hintCache: Map<string, number>,
): RenderWindowSegment[] => {
    const children = root.children_ || [];
    const pinned: number[] = [];
    const addUuid = (uuid: string | null | undefined) => {
        if (!uuid) return;
        const index = resolveTopLevelIndex(root, uuid, hintCache.get(uuid));
        if (index === null) {
            hintCache.delete(uuid);
            return;
        }
        hintCache.set(uuid, index);
        pinned.push(index);
    };
    for (const uuid of forcedUuids) addUuid(uuid);
    if (window.pinnedUuids) {
        for (const uuid of window.pinnedUuids) addUuid(uuid);
    }
    // Tail autofill paragraph: the click-below-the-document landing zone must
    // exist even when the window is pinned to the top of a huge document.
    const last = children.length - 1;
    if (last >= 0 && children[last].isAutoFill_) pinned.push(last);
    return computeRenderWindowPlan(children.length, window, pinned);
};
