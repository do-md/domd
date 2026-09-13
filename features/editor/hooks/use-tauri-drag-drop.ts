"use client";
import { useEffect, useState } from "react";
import { isImagePath } from "@/common/lib/image-storage";
import { isMdPath, isTauri } from "@/common/lib/platform";
import { tauriWebview } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";

// Listens for native Tauri drag-drop events. Returns whether a non-image
// drag is currently over the window. Image-only drags suppress the overlay
// because the image-drop hook inserts them inline.
//
// Hands back EVERY markdown path in the drop, in order — a window holds
// several documents now, so a multi-file drop opens one tab each instead of
// silently keeping only the first file.
export function useTauriDragDrop(onDropMd: (paths: string[]) => void) {
    const [dragging, setDragging] = useState(false);
    const onDropMdRef = useLatest(onDropMd);

    useEffect(() => {
        if (!isTauri()) return;
        let cleanup: (() => void) | null = null;
        // `over` events don't carry paths, so remember the decision made on
        // `enter` to keep the overlay suppressed for image-only drags.
        let suppressOverlay = false;

        tauriWebview().then(({ getCurrentWebview }) => {
            const unlisten = getCurrentWebview().onDragDropEvent((e) => {
                const { type } = e.payload;
                if (type === "enter") {
                    const paths =
                        (e.payload as { paths?: string[] }).paths ?? [];
                    suppressOverlay =
                        paths.length > 0 && paths.some(isImagePath);
                    if (!suppressOverlay) setDragging(true);
                } else if (type === "over") {
                    if (!suppressOverlay) setDragging(true);
                } else if (type === "leave") {
                    setDragging(false);
                    suppressOverlay = false;
                } else if (type === "drop") {
                    setDragging(false);
                    suppressOverlay = false;
                    const mds = (
                        e.payload as { paths: string[] }
                    ).paths.filter(isMdPath);
                    if (mds.length > 0) onDropMdRef.current(mds);
                }
            });
            unlisten.then((fn) => {
                cleanup = fn;
            });
        });

        return () => {
            cleanup?.();
        };
    }, [onDropMdRef]);

    return dragging;
}
