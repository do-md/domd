"use client";
import { useCallback, useRef, useState } from "react";

interface DragState {
    tabId: string;
    startX: number;
    currentIndex: number;
}

export function useTabDragReorder(
    tabIds: string[],
    onReorder: (fromIndex: number, toIndex: number) => void,
) {
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const tabRectsRef = useRef<Map<string, DOMRect>>(new Map());

    const captureRects = useCallback((container: HTMLElement) => {
        const rects = new Map<string, DOMRect>();
        const tabs = container.querySelectorAll<HTMLElement>("[data-tab-id]");
        tabs.forEach((el) => {
            const id = el.dataset.tabId!;
            rects.set(id, el.getBoundingClientRect());
        });
        tabRectsRef.current = rects;
    }, []);

    const onPointerDown = useCallback(
        (e: React.PointerEvent, tabId: string, container: HTMLElement) => {
            if (e.button !== 0) return;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            captureRects(container);
            const index = tabIds.indexOf(tabId);
            dragRef.current = { tabId, startX: e.clientX, currentIndex: index };
            setDraggingId(tabId);
        },
        [tabIds, captureRects],
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;

            const rects = tabRectsRef.current;
            let targetIndex = drag.currentIndex;

            for (const [id, rect] of rects) {
                const midX = rect.left + rect.width / 2;
                const idx = tabIds.indexOf(id);
                if (e.clientX < midX && idx < targetIndex) {
                    targetIndex = idx;
                    break;
                }
                if (e.clientX > midX && idx > targetIndex) {
                    targetIndex = idx;
                }
            }

            if (targetIndex !== drag.currentIndex) {
                onReorder(drag.currentIndex, targetIndex);
                drag.currentIndex = targetIndex;
                const container = (e.currentTarget as HTMLElement).closest(
                    "[data-tab-bar]",
                );
                if (container) captureRects(container as HTMLElement);
            }
        },
        [tabIds, onReorder, captureRects],
    );

    const onPointerUp = useCallback(() => {
        dragRef.current = null;
        setDraggingId(null);
    }, []);

    return { draggingId, onPointerDown, onPointerMove, onPointerUp };
}
