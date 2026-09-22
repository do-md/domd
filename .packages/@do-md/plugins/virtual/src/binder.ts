/**
 * The DOM half: scroll tracking, block measurement, scroll anchoring and the
 * scrollToBlock driver. Blocks are located through the kernel's public DOM
 * contract — `[data-render-id]` on block elements, `[data-domd-root]` on the
 * editable root, `[data-domd-virtual-spacer]` on the seam's spacers — never
 * by text matching.
 *
 * One rAF-coalesced pass does everything in read→write order:
 *   1. READ  — mounted window blocks' rects (one layout pass, no thrash);
 *   2. WRITE — measured heights into the store's table; when offsets moved,
 *              anchor the scroll position to the first visible block so the
 *              content under the reader never jumps (manual anchoring —
 *              CSS overflow-anchor is disabled on the container while bound,
 *              the browser's anchor would fight the spacer resizes);
 *   3. READ  — viewport metrics into the store, which recomputes the window
 *              (overscan + hysteresis live in the pure layer).
 *
 * Passes are scheduled by: container scroll, container/root resize
 * (ResizeObserver), root DOM mutations (React window swaps, typing), and the
 * store's own window writes.
 */
import { flushSync } from "react-dom";
import type { VirtualStore } from "./store";

const ROOT_SELECTOR = "[data-domd-root]";
const RENDER_ID = "data-render-id";
const SPACER_ATTR = "data-domd-virtual-spacer";

/** Breathing room above a scrolled-to block (px). */
const SCROLL_MARGIN = 72;

interface MountedBlock {
    index: number;
    uuid: string;
    type: string;
    top: number;
    height: number;
}

export const bindVirtualViewport = (
    store: VirtualStore,
    container: HTMLElement,
): (() => void) => {
    let disposed = false;
    let framePending = false;
    /** Anchor captured before a pads-changing table update; applied on the
     *  first pass after React re-rendered the spacers. */
    let pendingAnchor: { uuid: string; top: number } | null = null;
    /** scrollToBlock convergence: after the estimate-based jump, keep pulling
     *  the target block toward the scroll margin across passes — freshly
     *  mounted neighbors correct the height table under it, so a single
     *  post-mount alignment can land off-screen. Stops when aligned (or the
     *  budget runs out); anchor correction is suppressed meanwhile.
     *  CRITICAL: alignment only trusts the element while its index is inside
     *  the window run — a kernel-forced pin (the caret just moved into the
     *  target, e.g. a TOC jump's moveCaret) mounts the SAME uuid adjacent to
     *  the OLD window's spacer edge, and aligning against that ghost position
     *  yanks the viewport straight back to where it came from. */
    let pendingScroll: {
        uuid: string;
        index: number;
        tries: number;
        stable: number;
    } | null = null;

    // The browser's native scroll anchoring reacts to our spacer resizes;
    // the pass does its own anchoring against model identity instead.
    const previousOverflowAnchor = container.style.overflowAnchor;
    container.style.overflowAnchor = "none";

    const rootEl = (): HTMLElement | null =>
        container.querySelector<HTMLElement>(ROOT_SELECTOR);

    const blockUuidOf = (el: Element): string | null =>
        el.getAttribute(RENDER_ID) ??
        el.querySelector(`[${RENDER_ID}]`)?.getAttribute(RENDER_ID) ??
        null;

    /** Mounted top-level blocks of the current window run, zipped with their
     *  model indexes by a bounded forward merge (both sides are in model
     *  order; null-rendered scaffolding blocks simply never appear on the
     *  DOM side). */
    const collectMounted = (root: HTMLElement): MountedBlock[] => {
        const window = store.state.window;
        if (!window) return [];
        const blocks = store.table.blocks;
        const mounted: MountedBlock[] = [];
        let modelIndex = window.startIndex;
        for (const el of Array.from(root.children)) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.hasAttribute(SPACER_ATTR)) continue;
            const uuid = blockUuidOf(el);
            if (!uuid) continue; // overlay/portal scaffolding
            // Advance past null-rendered model blocks to this element's
            // model position; a miss within the window run means the render
            // is mid-swap (stale against the current list) — skip it.
            let probe = modelIndex;
            while (probe < window.endIndex && blocks[probe]?.uuid !== uuid) {
                probe += 1;
            }
            if (probe >= window.endIndex) continue; // pinned/out-of-run block
            const rect = el.getBoundingClientRect();
            mounted.push({
                index: probe,
                uuid,
                type: blocks[probe].type,
                top: rect.top,
                height: rect.height,
            });
            modelIndex = probe + 1;
        }
        return mounted;
    };

    /** Height of block i = distance to the next mounted block's top, minus
     *  the estimated share of null-rendered blocks between them (normally 0).
     *  The margin between siblings is thereby attributed to the upper block —
     *  the sum over a contiguous run telescopes to the exact layout extent.
     *  The run's last block falls back to its border-box height until the
     *  window moves past it. */
    const measure = (mounted: MountedBlock[]): boolean => {
        if (mounted.length === 0) return false;
        const entries: { uuid: string; height: number; type?: string }[] = [];
        for (let i = 0; i < mounted.length; i++) {
            const current = mounted[i];
            const next = mounted[i + 1];
            if (next) {
                let between = 0;
                for (let k = current.index + 1; k < next.index; k++) {
                    between += store.table.heightOf(k);
                }
                entries.push({
                    uuid: current.uuid,
                    height: Math.max(0, next.top - current.top - between),
                    type: current.type,
                });
            } else if (!store.table.isMeasured(current.uuid)) {
                // Border-box only (no margin) — a strict underestimate,
                // replaced by the true delta once a successor mounts. Never
                // overwrite an existing delta measurement with it.
                entries.push({
                    uuid: current.uuid,
                    height: current.height,
                    type: current.type,
                });
            }
        }
        return store.recordHeights(entries);
    };

    const contentViewTop = (root: HTMLElement): number =>
        container.getBoundingClientRect().top -
        root.getBoundingClientRect().top;

    const pass = () => {
        if (disposed) return;
        const root = rootEl();
        if (!root) return;
        const active = store.state.active;

        // 1. Anchor correction FIRST: a pendingAnchor was captured on the
        //    pass that changed the height table; this pass runs after React
        //    re-rendered the spacers (mutation-scheduled), so putting the
        //    anchor block back at its captured viewport offset undoes the
        //    pads-induced shift under the reader. It must run before this
        //    pass's own measurement sets the NEXT anchor — applying an anchor
        //    in the same pass that set it is a no-op (the DOM has not moved
        //    yet) that would just burn the correction.
        if (pendingAnchor) {
            const anchor = pendingAnchor;
            pendingAnchor = null;
            const el = container.querySelector<HTMLElement>(
                `[${RENDER_ID}="${cssEscape(anchor.uuid)}"]`,
            );
            if (el) {
                const delta = el.getBoundingClientRect().top - anchor.top;
                if (Math.abs(delta) >= 1) {
                    container.scrollTop += delta;
                }
            }
        }

        // 2. Measure the mounted window run; on change, capture the anchor
        //    (first block under the viewport top) for the NEXT pass.
        if (active) {
            const mounted = collectMounted(root);
            const containerTop = container.getBoundingClientRect().top;
            const anchorBlock =
                mounted.find((m) => m.top + m.height > containerTop) ?? null;
            const changed = measure(mounted);
            if (changed && anchorBlock && !pendingScroll) {
                pendingAnchor = { uuid: anchorBlock.uuid, top: anchorBlock.top };
            }
            if (changed) schedule();
        }

        // 3. scrollToBlock convergence: pull the mounted target to the scroll
        //    margin until it HOLDS STILL for two consecutive passes — the
        //    first alignment often lands before the freshly mounted
        //    neighborhood is measured, and the follow-up pad corrections
        //    shift the target again. Only an element rendered INSIDE the
        //    window run counts: the same uuid mounted as a kernel-forced pin
        //    sits at a ghost position by the old window's edge, and aligning
        //    against the ghost would yank the viewport back where it came
        //    from.
        if (pendingScroll) {
            pendingScroll.tries -= 1;
            const win = store.state.window;
            const inRun =
                win === null ||
                (pendingScroll.index >= win.startIndex &&
                    pendingScroll.index < win.endIndex);
            const el = inRun
                ? container.querySelector<HTMLElement>(
                      `[${RENDER_ID}="${cssEscape(pendingScroll.uuid)}"]`,
                  )
                : null;
            if (el) {
                const delta =
                    el.getBoundingClientRect().top -
                    container.getBoundingClientRect().top -
                    SCROLL_MARGIN;
                if (Math.abs(delta) < 1) {
                    pendingScroll.stable += 1;
                    if (pendingScroll.stable >= 2 || pendingScroll.tries <= 0) {
                        pendingScroll = null;
                    } else {
                        schedule();
                    }
                } else {
                    pendingScroll.stable = 0;
                    container.scrollTop += delta;
                    if (pendingScroll.tries <= 0) pendingScroll = null;
                    else schedule();
                }
            } else if (pendingScroll.tries <= 0) {
                pendingScroll = null;
            } else {
                schedule();
            }
        }

        store.setViewport(contentViewTop(root), container.clientHeight);
    };

    const schedule = () => {
        if (disposed || framePending) return;
        framePending = true;
        requestAnimationFrame(() => {
            framePending = false;
            pass();
        });
    };

    // Scrolling updates the window SYNCHRONOUSLY (store.syncViewport pulls
    // the live geometry below), then asks for a measurement pass. Doing the
    // window half on the event itself is what keeps scrolling alive while the
    // main thread is too saturated for rAF — the state a chunked load of a
    // large document puts the page in for seconds at a time.
    const onScroll = () => {
        store.syncViewport();
        schedule();
    };
    container.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver =
        typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(schedule)
            : null;
    resizeObserver?.observe(container);
    const observedRoot = rootEl();
    if (observedRoot) resizeObserver?.observe(observedRoot);

    // React window swaps + typing growth. characterData catches text-node
    // edits that change block heights without childList changes.
    const mutationObserver =
        typeof MutationObserver !== "undefined"
            ? new MutationObserver(schedule)
            : null;
    if (observedRoot) {
        mutationObserver?.observe(observedRoot, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    // Native print (web Cmd+P): materialize the full document synchronously
    // before the print snapshot, restore after. The app's export flows use
    // materializeForPrint instead (async, awaitable).
    const onBeforePrint = () => {
        if (!store.state.active) return;
        flushSync(() => store.setForceFull(true));
        beforePrintHeld = true;
    };
    const onAfterPrint = () => {
        if (!beforePrintHeld) return;
        beforePrintHeld = false;
        store.setForceFull(false);
    };
    let beforePrintHeld = false;
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);

    const driver = {
        scrollToIndex: (index: number, uuid: string) => {
            const root = rootEl();
            if (!root) return;
            const rootTop =
                root.getBoundingClientRect().top -
                container.getBoundingClientRect().top +
                container.scrollTop;
            const target =
                rootTop + store.table.offsetOf(index) - SCROLL_MARGIN;
            container.scrollTop = Math.max(0, target);
            // ~0.5s of frames: the jump's window swap needs several React
            // commits (mount + measurement corrections) before the target's
            // real position settles.
            pendingScroll = { uuid, index, tries: 30, stable: 0 };
            schedule();
        },
        blockViewportTop: (index: number): number | null => {
            const root = rootEl();
            if (!root) return null;
            return (
                root.getBoundingClientRect().top + store.table.offsetOf(index)
            );
        },
        schedule,
    };
    store.attachDomDriver(driver);
    // Live viewport source: content-coordinate top of the viewport plus its
    // height, read fresh on every window recompute (see VirtualStore's
    // viewportProvider_). Null while the editor root is detached.
    store.attachViewportProvider(() => {
        const root = rootEl();
        if (!root) return null;
        return {
            viewTop: contentViewTop(root),
            height: container.clientHeight,
        };
    });

    // First pass without waiting for a scroll event.
    pass();

    return () => {
        disposed = true;
        store.attachDomDriver(null);
        store.attachViewportProvider(null);
        container.removeEventListener("scroll", onScroll);
        window.removeEventListener("beforeprint", onBeforePrint);
        window.removeEventListener("afterprint", onAfterPrint);
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        container.style.overflowAnchor = previousOverflowAnchor;
        if (beforePrintHeld) store.setForceFull(false);
    };
};

const cssEscape = (value: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(value)
        : value.replace(/["\\]/g, "\\$&");

/**
 * Full-DOM materialization for export/print flows: forces every block to
 * mount, resolves after the re-render committed (two frames), and returns
 * the release. No-op (immediate resolve) when virtualization is inactive.
 *
 *     const release = await materializeForPrint(virtualStore);
 *     try { ...clone DOM / invoke native print... } finally { release(); }
 */
export const materializeForPrint = async (
    store: VirtualStore,
): Promise<() => void> => {
    if (!store.state.active) return () => {};
    store.setForceFull(true);
    await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    let released = false;
    return () => {
        if (released) return;
        released = true;
        store.setForceFull(false);
    };
};
