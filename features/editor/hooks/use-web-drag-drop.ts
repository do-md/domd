"use client";
import { useCallback, useState } from "react";
import { isMdPath } from "@/common/lib/platform";
import { useLatest } from "@/common/lib/use-latest";

export type WebDropPayload = {
    file: File;
    handle: FileSystemFileHandle | null;
};

// Returns drag state and handlers for replacing the current document via
// a drop on the page. Image drags are skipped — the image-drop hook handles
// those inline.
export function useWebDragDrop(onDropMd: (payload: WebDropPayload) => void) {
    const [dragging, setDragging] = useState(false);
    const onDropMdRef = useLatest(onDropMd);

    const onDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const hasImage = Array.from(e.dataTransfer.items).some(
            (i) => i.kind === "file" && i.type.startsWith("image/"),
        );
        if (!hasImage) setDragging(true);
    }, []);

    const onDragLeave = useCallback(() => setDragging(false), []);

    const onDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const item = Array.from(e.dataTransfer.items).find(
            (i) => i.kind === "file",
        );
        if (!item) return;
        const file = item.getAsFile();
        if (!file || !isMdPath(file.name)) return;

        let handle: FileSystemFileHandle | null = null;
        if ("getAsFileSystemHandle" in item) {
            try {
                const h = await (
                    item as DataTransferItem & {
                        getAsFileSystemHandle(): Promise<FileSystemHandle>;
                    }
                ).getAsFileSystemHandle();
                if (h.kind === "file") handle = h as FileSystemFileHandle;
            } catch {
                /* ignore */
            }
        }

        onDropMdRef.current({ file, handle });
    }, [onDropMdRef]);

    return { dragging, dragHandlers: { onDragOver, onDragLeave, onDrop } };
}
