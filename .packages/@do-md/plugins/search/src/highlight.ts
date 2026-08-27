/**
 * Match painting via the CSS Custom Highlight API — the browser's own
 * find-in-page rendering path: no DOM mutation, no overlay rectangles, no
 * resize listeners (Ranges are logical positions, not geometry).
 *
 * Anchoring: the store's match ranges resolve (kernel `resolveRanges`) to
 * block coordinates `{ uuid, offset }`, and this module positions them in the
 * DOM exactly the way remote cursors are drawn — `[data-render-id="${uuid}"]`
 * plus a text-node walk. The walk skips view-only decoration subtrees
 * (`data-domd-view-only`, the kernel's public contract), mirroring the
 * kernel's own cursor-to-DOM math.
 *
 * The consuming layer styles the two highlight names in CSS:
 *
 *   ::highlight(domd-search)        { background-color: ...; }
 *   ::highlight(domd-search-active) { background-color: ...; }
 *
 * Repaint policy is the caller's (see bindSearchPainter): ranges die when
 * React replaces the underlying text nodes, so repaint after every op batch
 * and cursor move (markdown-mode symbol reveal re-renders spans), throttled
 * to animation frames.
 */
import { DATA_VIEW_ONLY } from "@do-md/core-react";
import type { RangeAnchor, ResolvedMatchRange, SearchStore } from "./store";

export const SEARCH_HIGHLIGHT = "domd-search";
export const SEARCH_HIGHLIGHT_ACTIVE = "domd-search-active";

/** Chrome 105+, Safari 17.4+, Firefox 140+. On anything older the engine
 *  still counts/navigates/replaces — it just cannot paint. */
export const supportsHighlightPainting = (): boolean =>
    typeof CSS !== "undefined" && "highlights" in CSS;

const DATA_RENDER_ID = "data-render-id";

/** True when the node sits inside a view-only decoration subtree (bounded by
 *  `block`) — such text occupies DOM but no model offsets. */
const isViewOnlyText = (node: Node, block: Element): boolean => {
    let parent = node.parentElement;
    while (parent && parent !== block) {
        if (parent.hasAttribute(DATA_VIEW_ONLY)) return true;
        parent = parent.parentElement;
    }
    return false;
};

/** Resolve (block uuid, in-block offset) to a text-node position — the
 *  remote-cursor walk, view-only aware. Null when the block is gone or holds
 *  no text nodes. */
const resolveTextPoint = (
    container: HTMLElement,
    anchor: RangeAnchor,
): { node: Text; offset: number } | null => {
    const block = container.querySelector<HTMLElement>(
        `[${DATA_RENDER_ID}="${CSS.escape(anchor.uuid)}"]`,
    );
    if (!block) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
            isViewOnlyText(node, block)
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT,
    });
    let remaining = anchor.offset;
    let node = walker.nextNode() as Text | null;
    let last: Text | null = null;
    while (node) {
        const length = node.textContent?.length ?? 0;
        last = node;
        if (remaining <= length) {
            return { node, offset: Math.min(remaining, length) };
        }
        remaining -= length;
        node = walker.nextNode() as Text | null;
    }
    if (last) return { node: last, offset: last.length };
    return null;
};

const toDomRange = (
    container: HTMLElement,
    resolved: ResolvedMatchRange,
): Range | null => {
    const start = resolveTextPoint(container, resolved.start);
    const end = resolveTextPoint(container, resolved.end);
    if (!start || !end) return null;
    const range = document.createRange();
    try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
    } catch {
        return null;
    }
    if (range.collapsed) return null;
    return range;
};

/** Paint one frame of highlights. `activeIndex` addresses `anchors` (slot
 *  order = match order); the active range paints under its own name, above
 *  the rest. */
export const paintHighlights = (
    container: HTMLElement,
    anchors: (ResolvedMatchRange | null)[],
    activeIndex: number,
): void => {
    if (!supportsHighlightPainting()) return;
    const all: Range[] = [];
    let active: Range | null = null;
    anchors.forEach((resolved, index) => {
        if (!resolved) return;
        const range = toDomRange(container, resolved);
        if (!range) return;
        if (index === activeIndex) active = range;
        else all.push(range);
    });
    const registry = CSS.highlights;
    const passive = new Highlight(...all);
    registry.set(SEARCH_HIGHLIGHT, passive);
    if (active) {
        const highlight = new Highlight(active);
        highlight.priority = 1;
        registry.set(SEARCH_HIGHLIGHT_ACTIVE, highlight);
    } else {
        registry.delete(SEARCH_HIGHLIGHT_ACTIVE);
    }
};

export const clearHighlights = (): void => {
    if (!supportsHighlightPainting()) return;
    CSS.highlights.delete(SEARCH_HIGHLIGHT);
    CSS.highlights.delete(SEARCH_HIGHLIGHT_ACTIVE);
};

/** Scroll the active match into view, centered when off-screen. */
const scrollToRange = (container: HTMLElement, range: Range): void => {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    let scroller: HTMLElement | null = container;
    while (scroller) {
        const style = getComputedStyle(scroller);
        if (/(auto|scroll|overlay)/.test(style.overflowY)) break;
        scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
    scroller.scrollTop +=
        rect.top - view.top - view.height / 2 + rect.height / 2;
};

/** The editor subset the painter observes. `subscribeCursorChange` is
 *  optional but recommended: caret moves re-render markdown syntax symbols,
 *  which replaces the very text nodes the ranges hang on. */
export interface PaintableEditor {
    subscribeRenderDataOps(listener: (ops: unknown[]) => void): () => void;
    subscribeCursorChange?(listener: (cursor: unknown) => void): () => void;
}

/**
 * Wire a SearchStore to a live editor container: repaints on search state
 * changes, document ops and cursor moves (rAF-throttled — Ranges do not
 * survive React re-renders), scrolls to the active match when it changes,
 * clears on dispose. Returns the dispose.
 */
export const bindSearchPainter = (
    search: SearchStore,
    editor: PaintableEditor,
    container: HTMLElement,
): (() => void) => {
    if (!supportsHighlightPainting()) return () => {};

    let disposed = false;
    let framePending = false;
    let lastActiveIndex = -1;
    /** Anchors are model-level: they only change when matches change, not
     *  when React re-renders — cache per matches array identity. */
    let anchorsFor: unknown = null;
    let anchors: (ResolvedMatchRange | null)[] = [];

    const paint = () => {
        if (disposed) return;
        const { open, matches, activeIndex } = search.state;
        if (!open || matches.length === 0) {
            clearHighlights();
            lastActiveIndex = -1;
            anchorsFor = null;
            return;
        }
        if (anchorsFor !== matches) {
            anchors = search.resolveMatchAnchors();
            anchorsFor = matches;
        }
        paintHighlights(container, anchors, activeIndex);
        if (activeIndex !== lastActiveIndex && activeIndex >= 0) {
            lastActiveIndex = activeIndex;
            const resolved =
                anchors[activeIndex] ??
                // Beyond the resolution cap the active match rides in the
                // extra tail slot resolveMatchAnchors appends.
                anchors[anchors.length - 1];
            const range = resolved ? toDomRange(container, resolved) : null;
            if (range) scrollToRange(container, range);
        }
    };

    const schedule = () => {
        if (disposed) return;
        // Closing must not wait for a frame: rAF is suspended in hidden tabs,
        // which would leave stale highlights behind a dismissed widget.
        if (!search.state.open || search.state.matches.length === 0) {
            clearHighlights();
            lastActiveIndex = -1;
            anchorsFor = null;
            return;
        }
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(() => {
            framePending = false;
            paint();
        });
    };

    // The op/cursor subscriptions cover model-driven re-renders, but some
    // re-renders emit neither — the rich↔markdown mode toggle rebuilds every
    // span with zero model change, killing the very text nodes the Ranges
    // hang on. A MutationObserver on the container is the catch-all: any DOM
    // rebuild schedules a repaint. Safe against feedback loops — painting
    // goes through CSS.highlights, which never mutates the DOM.
    const observer = new MutationObserver(schedule);
    observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    const unsubscribers = [
        search.subscribe(schedule),
        editor.subscribeRenderDataOps(schedule),
        editor.subscribeCursorChange?.(schedule),
    ];
    schedule();

    return () => {
        disposed = true;
        observer.disconnect();
        for (const unsubscribe of unsubscribers) unsubscribe?.();
        clearHighlights();
    };
};
