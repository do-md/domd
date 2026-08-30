/**
 * The DOM half: scroll spy + click jump. Heading blocks are located through
 * the kernel's public DOM contract — `[data-render-id="<uuid>"]` on every
 * block element — never by text matching.
 *
 * The spy is the scroll-event flavor (Docusaurus' useTOCHighlight, tocbot),
 * NOT IntersectionObserver: an editor's content height changes constantly
 * (typing, images loading), and a full recompute per scroll frame over
 * O(dozens) of headings is cheap, deterministic and always self-consistent,
 * whereas IO's cached intersection state goes stale the moment layout moves
 * without scrolling. Every pass is rAF-coalesced.
 *
 * Active-heading decision (the Docusaurus three-rule algorithm, ported from
 * viewport to an inner scroll container):
 *   1. find the first heading at or below the anchor line (container top +
 *      anchorOffset);
 *   2. if it sits in the TOP HALF of the container it is the active one,
 *      otherwise the viewport still shows the PREVIOUS section — the
 *      previous heading is active (none before it → null: the reader is
 *      above the first section);
 *   3. scrolled to the very bottom → the last heading is active (a short
 *      final section could otherwise never win).
 *
 * Pin override: a panel click pins the clicked heading (store.pinActive) —
 * a late heading often cannot reach the container top, and honest
 * arbitration (rule 3 especially) would instantly hand the highlight to a
 * different entry than the one just clicked. While pinned the spy computes
 * nothing; the pin is released on the first scroll event past a short grace
 * window (the window swallows the jump's own programmatic scroll events —
 * scrollIntoView, the next-frame corrective, the caret-replay nudge), i.e.
 * on the first genuine user scroll.
 */
import { TocStore } from "./store";

export interface TocSpyOptions {
    /** Anchor line offset in px below the container's top edge. */
    anchorOffset?: number;
}

/** Scroll events younger than this since a pinActive() are treated as the
 *  jump's own (programmatic) scrolling and do not release the pin. */
const PIN_GRACE_MS = 500;

const cssEscape = (value: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(value)
        : value.replace(/["\\]/g, "\\$&");

const findBlock = (scope: ParentNode, uuid: string): HTMLElement | null =>
    scope.querySelector<HTMLElement>(`[data-render-id="${cssEscape(uuid)}"]`);

/**
 * Scroll a heading block to the top of its scroll container. Vertical
 * breathing room comes from CSS `scroll-margin-top` on the block (the
 * app's stylesheet owns that number). Returns false when the block is not
 * in the DOM (stale uuid — the outline will catch up on its next scan).
 */
export const scrollToHeading = (
    scope: ParentNode,
    uuid: string,
    options: { behavior?: ScrollBehavior } = {},
): boolean => {
    const el = findBlock(scope, uuid);
    if (!el) return false;
    el.scrollIntoView({ block: "start", behavior: options.behavior ?? "auto" });
    return true;
};

/**
 * Track the scroll position of `container` (the editor's scroll area) and
 * keep `store.state.activeUuid` pointing at the section under the reader.
 * Recomputes on scroll, container resize and outline changes; call the
 * returned dispose on unmount.
 */
export const bindTocSpy = (
    store: TocStore,
    container: HTMLElement,
    options: TocSpyOptions = {},
): (() => void) => {
    const anchorOffset = options.anchorOffset ?? 8;
    // uuid → element; entries are revalidated per pass (isConnected), so a
    // re-render that swaps block elements self-heals on the next compute.
    const cache = new Map<string, HTMLElement>();

    const elementFor = (uuid: string): HTMLElement | null => {
        const cached = cache.get(uuid);
        if (cached && cached.isConnected) return cached;
        cache.delete(uuid);
        const el = findBlock(container, uuid);
        if (el) cache.set(uuid, el);
        return el;
    };

    const compute = () => {
        const fromScroll = pendingScroll;
        pendingScroll = false;
        const pinAge = store.pinAge();
        if (pinAge !== null) {
            // Only a genuine user scroll (past the grace window) releases
            // the pin; resize, outline changes and the jump's own scroll
            // events leave the clicked entry highlighted.
            if (!fromScroll || pinAge < PIN_GRACE_MS) return;
            store.unpin();
        }
        const { headings } = store.state;
        if (headings.length === 0) {
            store.setActive(null);
            return;
        }
        // Rule 3: pinned to the bottom → last heading wins outright. Only
        // when there IS a bottom to reach: a document shorter than the
        // container satisfies the arithmetic at all times, which would keep
        // the LAST heading lit while the reader is looking at the top.
        const scrollable =
            container.scrollHeight - container.clientHeight > 2;
        const atBottom =
            scrollable &&
            container.scrollTop + container.clientHeight >=
                container.scrollHeight - 2;
        if (atBottom) {
            store.setActive(headings[headings.length - 1].uuid);
            return;
        }
        const containerRect = container.getBoundingClientRect();
        const anchorLine = containerRect.top + anchorOffset;
        const half = containerRect.top + container.clientHeight / 2;
        let previous: string | null = null;
        for (const heading of headings) {
            const el = elementFor(heading.uuid);
            if (!el) continue;
            const top = el.getBoundingClientRect().top;
            if (top >= anchorLine) {
                // Rules 1 + 2: the first heading below the anchor line is
                // active only while it sits in the container's top half.
                store.setActive(top < half ? heading.uuid : previous);
                return;
            }
            previous = heading.uuid;
        }
        // Every heading is above the anchor line → the last one is active.
        store.setActive(previous);
    };

    let frame: number | null = null;
    let pendingScroll = false;
    const schedule = () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            compute();
        });
    };
    const onScroll = () => {
        pendingScroll = true;
        schedule();
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    const resizeObserver =
        typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(schedule)
            : null;
    resizeObserver?.observe(container);
    const unsubscribeStore = store.subscribe(schedule);
    // First paint: synchronous, so the panel opens with a highlight without
    // waiting for a scroll event.
    compute();

    return () => {
        container.removeEventListener("scroll", onScroll);
        resizeObserver?.disconnect();
        unsubscribeStore();
        if (frame !== null) cancelAnimationFrame(frame);
        cache.clear();
    };
};
