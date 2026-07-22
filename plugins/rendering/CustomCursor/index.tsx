import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore, useEditorDom } from "@do-md/core-react";

let styleInjected = false;
function injectBlinkStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.textContent = `@keyframes domd-cursor-blink{0%,100%{opacity:1}50%{opacity:0}}`;
    document.head.appendChild(style);
}

/** Starting from node (excluding itself), find the next leaf node within the same root */
function getNextLeaf(node: Node, root: Node): Node | null {
    let cur: Node | null = node;
    while (cur && cur !== root) {
        if (cur.nextSibling) {
            let leaf: Node = cur.nextSibling;
            while (leaf.firstChild) leaf = leaf.firstChild;
            return leaf;
        }
        cur = cur.parentNode;
    }
    return null;
}

/** Measure the left edge of the character at `index` in a text node, used as the cursor rect */
function measureCharLeft(node: Node, index: number): DOMRect | null {
    const r = document.createRange();
    r.setStart(node, index);
    r.setEnd(node, index + 1);
    const rects = r.getClientRects();
    if (!rects.length) return null;
    // A line-start character may return two rects (a zero-width rect at the end of
    // the previous line + the character rect on this line); take the last one to
    // bias toward "next line" — matching how the native caret is drawn at these positions.
    const rect = rects[rects.length - 1];
    return new DOMRect(rect.left, rect.top, 0, rect.height);
}

/**
 * Caret-style rect (zero width) derived from a leaf element's own box —
 * the <br> of an empty paragraph, embeds, etc.
 */
function measureLeafElementRect(el: HTMLElement): DOMRect | null {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0) {
        return new DOMRect(rect.left, rect.top, 0, rect.height);
    }
    // Some engines report a zero-height box for a bare <br>; selecting the
    // node with a Range still yields the line box it creates.
    const r = document.createRange();
    r.selectNode(el);
    const rects = r.getClientRects();
    if (rects.length) {
        const last = rects[rects.length - 1];
        if (last.height > 0) {
            return new DOMRect(last.left, last.top, 0, last.height);
        }
    }
    return null;
}

/**
 * The rect of the content just *after* a collapsed cursor — its downstream
 * position. Used to place the cursor at a line-start (right after a hard \n)
 * or in an empty paragraph, where getBoundingClientRect is unreliable across
 * engines. Returns null when there is no measurable downstream content.
 */
function getDownstreamRect(range: Range, container: HTMLElement): DOMRect | null {
    let node: Node = range.startContainer;
    let offset = range.startOffset;

    // Element-container boundary. Engines report the caret in an empty
    // paragraph (<p><br></p>) as (p, 0) — the <br> is a CHILD of the boundary
    // node, so a BR-startContainer check alone never fires there and the
    // cursor was never drawn. Resolve the boundary down to the concrete leaf
    // it points at before measuring.
    if (node.nodeType === Node.ELEMENT_NODE && node.nodeName !== "BR") {
        let leaf: Node | null =
            node.childNodes[offset] ?? node.lastChild;
        while (leaf && leaf.firstChild) leaf = leaf.firstChild;
        if (!leaf) return null;
        // Adopting lastChild (offset past the end) is only safe for a <br>:
        // the caret then sits on the line the <br> itself creates. Any other
        // leaf there is upstream content, not downstream.
        if (offset >= node.childNodes.length && leaf.nodeName !== "BR") {
            return null;
        }
        node = leaf;
        offset = 0;
    }

    // The caret's reference leaf is an element (empty paragraph's <br>,
    // embeds): use its own box.
    if (node instanceof HTMLElement) {
        return measureLeafElementRect(node);
    }

    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent || "";

    // Same node has a following character → its left edge.
    if (offset < text.length) {
        return measureCharLeft(node, offset);
    }

    // End of node: downstream content lives in the next leaf (code-block tokens
    // are split into multiple spans, so a line-start position lands at the end
    // of the previous line's \n node).
    const leaf = getNextLeaf(node, container);
    if (leaf && leaf.nodeType === Node.TEXT_NODE) {
        return (leaf.textContent || "").length > 0
            ? measureCharLeft(leaf, 0)
            : null;
    }
    if (leaf instanceof HTMLElement) {
        return measureLeafElementRect(leaf);
    }
    return null;
}

function getCursorRect(container: HTMLElement) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();

    if (range.collapsed) {
        const node = range.startContainer;
        const offset = range.startOffset;
        const text =
            node.nodeType === Node.TEXT_NODE ? node.textContent || "" : "";

        // Cross-engine line-start fix. When the cursor sits right after a hard \n
        // (i.e. the start of the next visual line), getBoundingClientRect places
        // the rect on the PREVIOUS line — Chrome returns a zero-height empty rect,
        // Safari returns a non-zero rect at the previous line's position. Both are
        // wrong; use the downstream content's position instead. Only override when
        // the main rect is empty OR the downstream rect is genuinely on a lower
        // visual line, so a correct main rect is never disturbed.
        if (text[offset - 1] === "\n") {
            const downstream = getDownstreamRect(range, container);
            if (
                downstream &&
                (rect.height === 0 ||
                    downstream.top > rect.top + rect.height / 2)
            ) {
                rect = downstream;
            }
        }

        // Remaining empty-rect boundaries (empty paragraph <br>, other edges):
        // try downstream content, else fall back to the previous character's
        // right edge (skip when it's a \n — that rect sits on the previous line).
        if (rect.height === 0) {
            const downstream = getDownstreamRect(range, container);
            if (downstream) {
                rect = downstream;
            } else if (
                node.nodeType === Node.TEXT_NODE &&
                offset > 0 &&
                text[offset - 1] !== "\n"
            ) {
                const fallbackRange = range.cloneRange();
                fallbackRange.setStart(node, offset - 1);
                fallbackRange.setEnd(node, offset);
                const rects = fallbackRange.getClientRects();
                if (rects.length > 0) {
                    const lastRect = rects[rects.length - 1];
                    rect = new DOMRect(
                        lastRect.right,
                        lastRect.top,
                        0,
                        lastRect.height,
                    );
                }
            }
        }
    }

    if (rect.height === 0) return null;

    const containerRect = container.getBoundingClientRect();

    return {
        x: rect.left - containerRect.left + container.scrollLeft,
        y: rect.top - containerRect.top + container.scrollTop,
        height: rect.height,
    };
}

export function CustomCursor() {
    const { textAreaDomRef } = useEditorDom();
    const startCursorInfo = useEditorStore((store) => store.startCursorInfo);
    const duringComposition = useEditorStore(
        (store) => store.duringComposition,
    );

    const cursorRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number>(0);
    const lastPosRef = useRef({ x: -1, y: -1 });
    // Remembers this container's own inline caret-color before we override it,
    // so unmounting restores exactly what was there (revealing the native caret).
    const originalCaretColorRef = useRef<string | null>(null);
    const [mounted, setMounted] = useState(false);
    // True while a non-collapsed (range) selection lives inside this editor.
    // Updated from the selectionchange-driven updatePosition; React bails out
    // of no-op setStates, so drag-selecting doesn't re-render per frame.
    const [hasRangeSelection, setHasRangeSelection] = useState(false);
    // Ref mirror so the synchronous selectionchange fast path reads the
    // latest composition state without re-binding the listener.
    const duringCompositionRef = useRef(duringComposition);
    duringCompositionRef.current = duringComposition;

    useEffect(() => {
        injectBlinkStyle();
    }, []);

    // Suppress the browser's native caret — scoped to THIS editor instance only.
    //
    // domd-core renders the native caret by default; mounting a CustomCursor is
    // what opts a given editor into custom cursor rendering. We therefore hide
    // the native caret by writing an inline `caret-color: transparent` onto this
    // instance's own Root element (textAreaDomRef.current). Because it's an inline
    // style on a specific DOM node — never a global stylesheet — sibling editors
    // that don't mount a CustomCursor keep their native caret untouched.
    //
    // During IME composition we temporarily restore the native caret so the
    // candidate window anchors to the real insertion point, and on unmount we
    // restore the original value so the native caret comes back for this editor.
    //
    // Range selections ALSO restore the native caret-color: iOS WebKit derives
    // the whole selection UI — the highlight tint AND the grab handles — from
    // the editable element's caret-color. Keeping it transparent while a range
    // exists paints the handles invisible and degrades the highlight to an
    // opaque grey block (the long-standing "black selection" bug on iOS,
    // diagnosed 2026-07-22). The custom cursor never draws for ranges anyway
    // (updatePosition hides it when !isCollapsed), so handing the selection UI
    // back to the system costs nothing on any platform.
    useEffect(() => {
        const container = textAreaDomRef.current;
        if (!container) return;

        // Capture the pre-existing inline value exactly once ("" = no override).
        if (originalCaretColorRef.current === null) {
            originalCaretColorRef.current = container.style.caretColor;
        }

        container.style.caretColor =
            duringComposition || hasRangeSelection
                ? originalCaretColorRef.current
                : "transparent";

        return () => {
            container.style.caretColor = originalCaretColorRef.current ?? "";
        };
    }, [duringComposition, hasRangeSelection, textAreaDomRef, mounted]);

    useEffect(() => {
        if (textAreaDomRef.current) {
            setMounted(true);
        }
    }, []);

    const show = useCallback(() => {
        const el = cursorRef.current;
        if (!el) return;
        el.style.opacity = "1";
        el.style.animation = "domd-cursor-blink 1s step-end infinite";
    }, []);

    const hide = useCallback(() => {
        const el = cursorRef.current;
        if (!el) return;
        el.style.opacity = "0";
        el.style.animation = "none";
    }, []);

    const resetBlink = useCallback(() => {
        const el = cursorRef.current;
        if (!el) return;
        el.style.animation = "none";
        void el.offsetHeight;
        el.style.animation = "domd-cursor-blink 1s step-end infinite";
    }, []);

    const updatePosition = useCallback(() => {
        const container = textAreaDomRef.current;
        const cursor = cursorRef.current;
        if (!container || !cursor) return;

        const sel = document.getSelection();

        // Feed the caret-suppression effect: a live range inside this editor
        // must hand caret-color (and with it, iOS's selection UI) back to the
        // system. Collapsed / outside / empty selections re-suppress it.
        setHasRangeSelection(
            !!sel &&
                sel.rangeCount > 0 &&
                !sel.isCollapsed &&
                container.contains(sel.anchorNode),
        );

        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
            hide();
            return;
        }

        if (!container.contains(sel.anchorNode)) {
            hide();
            return;
        }

        const pos = getCursorRect(container);
        if (!pos) {
            hide();
            return;
        }

        const moved =
            pos.x !== lastPosRef.current.x || pos.y !== lastPosRef.current.y;
        lastPosRef.current = { x: pos.x, y: pos.y };

        cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        cursor.style.height = `${pos.height}px`;

        if (moved) {
            resetBlink();
        } else {
            show();
        }
    }, [textAreaDomRef, show, hide, resetBlink]);

    const scheduleUpdate = useCallback(() => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updatePosition);
    }, [updatePosition]);

    useEffect(() => {
        if (startCursorInfo) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = requestAnimationFrame(updatePosition);
            });
        } else {
            hide();
        }
    }, [startCursorInfo, updatePosition, hide]);

    // selectionchange
    //
    // The caret-color hand-back must ALSO happen synchronously here, not only
    // via setHasRangeSelection → effect: iOS paints the selection UI (tint +
    // handles) with whatever caret-color it sees at first paint. The React
    // round-trip (rAF → setState → effect) lands a couple of frames later —
    // a double-tap word selection would stay grey until the user taps it
    // again and forces a repaint. Writing the inline style directly in the
    // event task beats that first paint; the effect then converges to the
    // same value (idempotent).
    useEffect(() => {
        const handler = () => {
            const container = textAreaDomRef.current;
            // During IME composition the suppression effect owns caret-color
            // (it must stay restored for the candidate window) — skip.
            if (container && !duringCompositionRef.current) {
                if (originalCaretColorRef.current === null) {
                    originalCaretColorRef.current = container.style.caretColor;
                }
                const sel = document.getSelection();
                const hasRange =
                    !!sel &&
                    sel.rangeCount > 0 &&
                    !sel.isCollapsed &&
                    container.contains(sel.anchorNode);
                container.style.caretColor = hasRange
                    ? originalCaretColorRef.current
                    : "transparent";
            }
            scheduleUpdate();
        };
        document.addEventListener("selectionchange", handler);
        return () => document.removeEventListener("selectionchange", handler);
    }, [scheduleUpdate, textAreaDomRef]);

    // IME: only manage the custom (fake) cursor here. During composition we hide
    // it and let the native caret show (the caret-suppression effect above handles
    // revealing it); once composition ends we redraw the custom cursor.
    // Native caret-color is owned entirely by the caret-suppression effect.
    useEffect(() => {
        const container = textAreaDomRef.current;
        if (!container) return;

        if (duringComposition) {
            hide();
        } else {
            scheduleUpdate();
        }
    }, [duringComposition, textAreaDomRef, scheduleUpdate, hide]);

    // blur / focus
    useEffect(() => {
        const container = textAreaDomRef.current;
        if (!container) return;

        const onBlur = () => hide();
        const onFocus = () => scheduleUpdate();

        container.addEventListener("blur", onBlur);
        container.addEventListener("focus", onFocus);
        return () => {
            container.removeEventListener("blur", onBlur);
            container.removeEventListener("focus", onFocus);
        };
    }, [textAreaDomRef, scheduleUpdate, hide]);

    // scroll / resize
    useEffect(() => {
        const container = textAreaDomRef.current;
        if (!container) return;

        const scrollParent = container.parentElement;
        if (!scrollParent) return;

        const onScroll = () => scheduleUpdate();
        scrollParent.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", scheduleUpdate);

        return () => {
            scrollParent.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", scheduleUpdate);
        };
    }, [textAreaDomRef, scheduleUpdate]);

    useEffect(() => {
        return () => cancelAnimationFrame(rafRef.current);
    }, []);

    if (!mounted || !textAreaDomRef.current) return null;

    return createPortal(
        <div
            ref={cursorRef}
            style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 2,
                opacity: 0,
                pointerEvents: "none",
                willChange: "transform",
                contain: "strict",
                backgroundColor: "rgb(0, 189, 184)",
                borderRadius: 1,
                zIndex: 10,
            }}
        />,
        textAreaDomRef.current,
    );
}
