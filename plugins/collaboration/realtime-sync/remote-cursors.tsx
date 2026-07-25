"use client";
/**
 * Remote caret rendering (the UI half of presence). Use inside a
 * DOMDProvider, next to <DOMD/>:
 *
 *   <RemoteCursors peers={peers} />
 *
 * Positioning (pure DOM + public attributes, no core internals — safe against
 * dist minification): a peer caret is uuid + in-block offset (core's stable
 * addressing). Find the block element via `[data-render-id="${uuid}"]`, walk
 * its text nodes to the offset -> Range -> caret rect (in editor-container
 * coordinates, same approach as CustomCursor).
 *
 * Re-measure triggers: peers change / any store change (document reflow) /
 * resize / scroll (capture listener covers any scroll container), throttled
 * via rAF.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
    height: number;
}

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
}

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
            const next: PeerCursorView[] = [];
            const resolveCursor = (store as ResolveCapableStore | null)
                ?.resolveCursorPosition;
            for (const peer of peersRef.current) {
                const start = peer.cursor?.start;
                if (!start) continue;
                // Span-anchored resolve (core >=0.4.2): recompute the in-block
                // offset from the anchored span's current prefix, so a peer
                // caret stays glued to its text while WE edit elsewhere in the
                // same block. Null = block gone, skip. Older cores: raw coords.
                let target: { uuid: string; offset: number } = start;
                if (resolveCursor) {
                    const resolved = resolveCursor.call(store, start);
                    if (!resolved) continue;
                    target = resolved;
                }
                const rect = measurePeerCursor(
                    container,
                    target.uuid,
                    target.offset,
                );
                if (!rect) continue;
                next.push({
                    clientId: peer.clientId,
                    name: peer.name,
                    color: peer.color,
                    rect,
                });
            }
            // Skip setState when nothing changed (avoids idle re-renders).
            setViews((prev) =>
                prev.length === next.length &&
                prev.every(
                    (v, i) =>
                        v.clientId === next[i].clientId &&
                        v.rect.x === next[i].rect.x &&
                        v.rect.y === next[i].rect.y &&
                        v.rect.height === next[i].rect.height,
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
                <div
                    key={v.clientId}
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
            ))}
        </>,
        portalEl,
    );
}
