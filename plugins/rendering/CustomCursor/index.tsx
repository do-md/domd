import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore, useEditorDom } from "@do-md/react";

let styleInjected = false;
function injectBlinkStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.textContent = `@keyframes domd-cursor-blink{0%,100%{opacity:1}50%{opacity:0}}`;
    document.head.appendChild(style);
}

function getCursorRect(container: HTMLElement) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();

    if (rect.height === 0 && range.collapsed) {
        const fallbackRange = range.cloneRange();
        if (range.startOffset > 0) {
            fallbackRange.setStart(range.startContainer, range.startOffset - 1);
            fallbackRange.setEnd(range.startContainer, range.startOffset);
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
        } else {
            const node = range.startContainer;
            if (node.textContent && node.textContent.length > 0) {
                fallbackRange.setStart(node, 0);
                fallbackRange.setEnd(node, 1);
                const rects = fallbackRange.getClientRects();
                if (rects.length > 0) {
                    rect = new DOMRect(
                        rects[0].left,
                        rects[0].top,
                        0,
                        rects[0].height,
                    );
                }
            } else if (node instanceof HTMLElement && node.tagName === "BR") {
                // Empty paragraph: startContainer is the <br> itself
                const brRect = node.getBoundingClientRect();
                if (brRect.height > 0) {
                    rect = new DOMRect(
                        brRect.left,
                        brRect.top,
                        0,
                        brRect.height,
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
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        injectBlinkStyle();
    }, []);

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
    useEffect(() => {
        const handler = () => scheduleUpdate();
        document.addEventListener("selectionchange", handler);
        return () => document.removeEventListener("selectionchange", handler);
    }, [scheduleUpdate]);

    // IME
    useEffect(() => {
        const container = textAreaDomRef.current;
        if (!container) return;

        if (duringComposition) {
            hide();
            container.style.caretColor = "";
        } else {
            container.style.caretColor = "transparent";
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
