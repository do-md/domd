"use client";
/**
 * Remote caret + selection rendering (the UI half of presence). Use inside
 * a DOMDProvider, next to <DOMD/>:
 *
 *   <RemoteCursors peers={peers} />
 *
 * Positioning (pure DOM + public attributes, no core internals — safe against
 * dist minification): a peer caret is uuid + in-block offset (core's stable
 * addressing). Find the block element via `[data-render-id="${uuid}"]`, walk
 * its text nodes to the offset -> Range -> caret rect (in editor-container
 * coordinates, same approach as CustomCursor).
 *
 * Selections: when a peer's CursorSnapshot carries a real range (start and
 * end differ — the wire already ships both ends), the two endpoints are
 * resolved to text positions and a DOM Range paints the highlight rects in
 * the peer's color; the caret is drawn at the range's end. Endpoint order is
 * normalized via compareBoundaryPoints — no assumption about selection
 * direction. A collapsed snapshot renders the caret exactly as before.
 *
 * Re-measure triggers: peers change / any store change (document reflow) /
 * resize / scroll (capture listener covers any scroll container), throttled
 * via rAF.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorDom, useEditorStoreApi } from "@do-md/core-react";
import type { CursorPosition } from "../crdt-sync/types";
import type { RealtimePeer } from "./index";

/** Structural view of the optional span-anchor resolver (core >=0.4.2). Typed
 *  locally so the plugin compiles against older installed cores. */
interface ResolveCapableStore {
    resolveCursorPosition?(
        cursor: CursorPosition,
    ): { uuid: string; offset: number } | null;
}

interface CursorRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const hexToRgba = (hex: string, alpha: number): string => {
    let h = hex.replace("#", "");
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const value = Number.parseInt(h, 16);
    if (Number.isNaN(value) || h.length !== 6) {
        return `rgba(138, 122, 168, ${alpha})`; // muted fallback
    }
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Resolve (block uuid, in-block offset) to a concrete text-node position.
 *  Null when the block is missing or holds no text nodes (empty block) —
 *  selection painting skips those; the caret path has its own fallbacks. */
const resolveTextPoint = (
    container: HTMLElement,
    uuid: string,
    offset: number,
): { node: Text; offset: number } | null => {
    const el = container.querySelector<HTMLElement>(
        `[data-render-id="${CSS.escape(uuid)}"]`,
    );
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode() as Text | null;
    let last: Text | null = null;
    while (node) {
        const len = node.textContent?.length ?? 0;
        last = node;
        if (remaining <= len) {
            return { node, offset: Math.min(remaining, len) };
        }
        remaining -= len;
        node = walker.nextNode() as Text | null;
    }
    if (last) return { node: last, offset: last.length };
    return null;
};

/** Client rects of the range between two cursor points, in either order
 *  (normalized via compareBoundaryPoints — selection direction is the
 *  peer's business, not the wire's). Null when either endpoint cannot be
 *  resolved. */
const measurePeerSelection = (
    container: HTMLElement,
    a: { uuid: string; offset: number },
    b: { uuid: string; offset: number },
): DOMRect[] | null => {
    const pa = resolveTextPoint(container, a.uuid, a.offset);
    const pb = resolveTextPoint(container, b.uuid, b.offset);
    if (!pa || !pb) return null;
    const ra = document.createRange();
    ra.setStart(pa.node, pa.offset);
    ra.collapse(true);
    const rb = document.createRange();
    rb.setStart(pb.node, pb.offset);
    rb.collapse(true);
    const reversed =
        ra.compareBoundaryPoints(Range.START_TO_START, rb) > 0;
    const [first, second] = reversed ? [pb, pa] : [pa, pb];
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(second.node, second.offset);
    return [...range.getClientRects()];
};

/** Locate the caret rect for a plain-text offset inside a block element (container coordinates). */
const measurePeerCursor = (
    container: HTMLElement,
    uuid: string,
    offset: number,
): CursorRect | null => {
    const el = container.querySelector<HTMLElement>(
        `[data-render-id="${CSS.escape(uuid)}"]`,
    );
    if (!el) return null;

    const containerRect = container.getBoundingClientRect();
    const toLocal = (rect: DOMRect): CursorRect => ({
        x: rect.left - containerRect.left + container.scrollLeft,
        y: rect.top - containerRect.top + container.scrollTop,
        width: 0,
        height: rect.height,
    });

    // Walk text nodes up to the offset.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode() as Text | null;
    let last: Text | null = null;
    while (node) {
        const len = node.textContent?.length ?? 0;
        last = node;
        if (remaining <= len) break;
        remaining -= len;
        node = walker.nextNode() as Text | null;
    }

    // Empty block (<br> placeholder) or offset out of range: fall back to the element box's left edge.
    if (!node) {
        if (last) {
            node = last;
            remaining = last.length;
        } else {
            const rect = el.getBoundingClientRect();
            if (rect.height === 0) return null;
            return toLocal(
                new DOMRect(rect.left, rect.top, 0, rect.height),
            );
        }
    }

    const clamped = Math.min(remaining, node.length);
    const range = document.createRange();
    range.setStart(node, clamped);
    range.collapse(true);
    let rect = range.getBoundingClientRect();

    // Empty-rect fallback: measure the next character's left edge or the previous character's right edge.
    if (rect.height === 0) {
        const probe = document.createRange();
        if (clamped < node.length) {
            probe.setStart(node, clamped);
            probe.setEnd(node, clamped + 1);
            const rects = probe.getClientRects();
            if (rects.length) {
                const r = rects[rects.length - 1];
                rect = new DOMRect(r.left, r.top, 0, r.height);
            }
        } else if (clamped > 0) {
            probe.setStart(node, clamped - 1);
            probe.setEnd(node, clamped);
            const rects = probe.getClientRects();
            if (rects.length) {
                const r = rects[rects.length - 1];
                rect = new DOMRect(r.right, r.top, 0, r.height);
            }
        }
    }
    if (rect.height === 0) return null;
    return toLocal(rect);
};

interface PeerCursorView {
    clientId: string;
    name: string;
    color: string;
    rect: CursorRect;
    /** Highlight rects of the peer's selected range (empty when collapsed). */
    selection: CursorRect[];
}

const rectsEqual = (a: CursorRect, b: CursorRect): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function RemoteCursors({ peers }: { peers: RealtimePeer[] }) {
    const { textAreaDomRef } = useEditorDom();
    const store = useEditorStoreApi();
    const [views, setViews] = useState<PeerCursorView[]>([]);
    /** Portal target, captured during measurement — refs are never read in render. */
    const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
    const rafRef = useRef(0);
    const peersRef = useRef(peers);

    const update = useCallback(() => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            const container = textAreaDomRef.current;
            if (!container) return;
            setPortalEl(container);
            const toLocal = (rect: DOMRect): CursorRect => {
                const containerRect = container.getBoundingClientRect();
                return {
                    x: rect.left - containerRect.left + container.scrollLeft,
                    y: rect.top - containerRect.top + container.scrollTop,
                    width: rect.width,
                    height: rect.height,
                };
            };

            const next: PeerCursorView[] = [];
            const resolveCursor = (store as ResolveCapableStore | null)
                ?.resolveCursorPosition;
            for (const peer of peersRef.current) {
                const start = peer.cursor?.start;
                if (!start) continue;
                const end = peer.cursor?.end ?? null;
                // Span-anchored resolve (core >=0.4.2): recompute the in-block
                // offset from the anchored span's current prefix, so a peer
                // caret stays glued to its text while WE edit elsewhere in the
                // same block. Null = block gone, skip. Older cores: raw coords.
                let startTarget: { uuid: string; offset: number } = start;
                let endTarget: { uuid: string; offset: number } | null = end;
                if (resolveCursor) {
                    const resolvedStart = resolveCursor.call(store, start);
                    if (!resolvedStart) continue;
                    startTarget = resolvedStart;
                    endTarget = end ? resolveCursor.call(store, end) : null;
                }
                const hasRange =
                    endTarget !== null &&
                    (endTarget.uuid !== startTarget.uuid ||
                        endTarget.offset !== startTarget.offset);
                let selection: CursorRect[] = [];
                if (hasRange) {
                    const rects = measurePeerSelection(
                        container,
                        startTarget,
                        endTarget!,
                    );
                    if (rects) {
                        selection = rects
                            .filter((r) => r.width > 0 && r.height > 0)
                            .map(toLocal);
                    }
                }
                // Caret sits at the range's end for a selection, at the
                // collapsed point otherwise.
                const caretTarget = hasRange ? endTarget! : startTarget;
                let rect = measurePeerCursor(
                    container,
                    caretTarget.uuid,
                    caretTarget.offset,
                );
                if (!rect && selection.length > 0) {
                    // Caret fallback: right edge of the selection's last rect.
                    const lastRect = selection[selection.length - 1];
                    rect = {
                        x: lastRect.x + lastRect.width,
                        y: lastRect.y,
                        width: 0,
                        height: lastRect.height,
                    };
                }
                if (!rect) continue;
                next.push({
                    clientId: peer.clientId,
                    name: peer.name,
                    color: peer.color,
                    rect,
                    selection,
                });
            }
            // Skip setState when nothing changed (avoids idle re-renders).
            setViews((prev) =>
                prev.length === next.length &&
                prev.every(
                    (v, i) =>
                        v.clientId === next[i].clientId &&
                        rectsEqual(v.rect, next[i].rect) &&
                        v.selection.length === next[i].selection.length &&
                        v.selection.every((r, j) =>
                            rectsEqual(r, next[i].selection[j]),
                        ),
                )
                    ? prev
                    : next,
            );
        });
    }, [textAreaDomRef, store]);

    // Peers changed -> keep the latest list for the rAF measurement, re-measure.
    useEffect(() => {
        peersRef.current = peers;
        update();
    }, [peers, update]);

    // Any document change (remote/local edits causing reflow) -> re-measure.
    useEffect(() => {
        if (!store) return;
        return store.subscribe(update);
    }, [store, update]);

    // Viewport changes.
    useEffect(() => {
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
            cancelAnimationFrame(rafRef.current);
        };
    }, [update]);

    if (!portalEl || views.length === 0) return null;

    return createPortal(
        <>
            {views.map((v) => (
                <Fragment key={v.clientId}>
                    {v.selection.map((r, i) => (
                        <div
                            key={i}
                            className="print:hidden"
                            style={{
                                position: "absolute",
                                left: r.x,
                                top: r.y,
                                width: r.width,
                                height: r.height,
                                background: hexToRgba(v.color, 0.18),
                                borderRadius: 2,
                                pointerEvents: "none",
                                zIndex: 35,
                            }}
                        />
                    ))}
                    <div
                        className="print:hidden"
                        style={{
                            position: "absolute",
                            left: v.rect.x,
                            top: v.rect.y,
                            height: v.rect.height,
                            width: 2,
                            background: v.color,
                            pointerEvents: "none",
                            zIndex: 40,
                        }}
                    >
                        <span
                            style={{
                                position: "absolute",
                                top: -19,
                                left: -2,
                                padding: "1px 6px",
                                borderRadius: 4,
                                fontSize: 10,
                                fontWeight: 500,
                                letterSpacing: 0.2,
                                lineHeight: "15px",
                                whiteSpace: "nowrap",
                                color: "#fff",
                                background: v.color,
                                boxShadow: "0 1px 2px rgb(0 0 0 / 0.15)",
                                userSelect: "none",
                            }}
                        >
                            {v.name}
                        </span>
                    </div>
                </Fragment>
            ))}
        </>,
        portalEl,
    );
}
