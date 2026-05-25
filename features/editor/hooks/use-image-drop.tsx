"use client";
import { useEffect } from "react";
import { useEditorStoreApi } from "@do-md/react";
import { storeImage, isImagePath } from "@/common/lib/image-storage";
import { isTauri } from "@/common/lib/platform";
import { tauriCore, tauriWebview } from "@/common/lib/tauri";

function basenameOf(path: string): string {
    const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return sep >= 0 ? path.slice(sep + 1) : path;
}

function mimeFromExt(ext: string): string {
    const e = ext.toLowerCase();
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "svg") return "image/svg+xml";
    return `image/${e}`;
}

async function insertImagesSequential(
    store: ReturnType<typeof useEditorStoreApi>,
    files: File[],
) {
    for (const file of files) {
        try {
            const { url, altText } = await storeImage(file);
            store?.insertImage(url, altText);
        } catch (err) {
            console.error("[image-drop] failed to store", file.name, err);
        }
    }
}

export function useImageDrop(): void {
    const store = useEditorStoreApi();

    // Web (HTML5) — capture-phase window listener so we can pre-empt the
    // wrapper-level .md drop handler when an image is dropped.
    useEffect(() => {
        if (isTauri()) return;
        if (typeof window === "undefined") return;

        const onDrop = (e: DragEvent) => {
            const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
                f.type.startsWith("image/"),
            );
            if (files.length === 0) return;
            // preventDefault to stop the browser from navigating to the file.
            // Do NOT stopPropagation: the wrapper's onDrop early-returns for
            // non-md files but still calls setDragging(false), which we want.
            e.preventDefault();
            void insertImagesSequential(store, files);
        };

        // Ensure drop fires on the document even outside the wrapper.
        const onDragOver = (e: DragEvent) => {
            if (
                Array.from(e.dataTransfer?.items ?? []).some(
                    (i) => i.kind === "file" && i.type.startsWith("image/"),
                )
            ) {
                e.preventDefault();
            }
        };

        window.addEventListener("drop", onDrop, true);
        window.addEventListener("dragover", onDragOver, true);
        return () => {
            window.removeEventListener("drop", onDrop, true);
            window.removeEventListener("dragover", onDragOver, true);
        };
    }, [store]);

    // Paste (Cmd/Ctrl+V) — covers screenshot pastes and image-from-browser
    // pastes on both web and Tauri (Tauri's webview is Chromium so the
    // standard clipboard event works).
    useEffect(() => {
        if (typeof window === "undefined") return;

        const onPaste = (e: ClipboardEvent) => {
            // Skip pastes targeting form inputs (e.g., the URL modal). The
            // editor is a contentEditable <div>, so this leaves it untouched.
            const target = e.target as HTMLElement | null;
            if (
                target &&
                (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
            ) {
                return;
            }
            const files = Array.from(e.clipboardData?.items ?? [])
                .filter(
                    (i) => i.kind === "file" && i.type.startsWith("image/"),
                )
                .map((i) => i.getAsFile())
                .filter((f): f is File => !!f);
            if (files.length === 0) return;
            // Pre-empt the core editor's text-paste handler so it doesn't
            // also try to paste a stringified version of the image.
            e.preventDefault();
            e.stopPropagation();
            void insertImagesSequential(store, files);
        };

        window.addEventListener("paste", onPaste, true);
        return () => window.removeEventListener("paste", onPaste, true);
    }, [store]);

    // Tauri — subscribe to the native drag-drop event for image paths.
    useEffect(() => {
        if (!isTauri()) return;

        let cleanup: (() => void) | null = null;
        let cancelled = false;

        tauriWebview().then(({ getCurrentWebview }) => {
            if (cancelled) return;
            const promise = getCurrentWebview().onDragDropEvent(async (e) => {
                if (e.payload.type !== "drop") return;
                const paths = (e.payload as { paths: string[] }).paths.filter(
                    isImagePath,
                );
                if (paths.length === 0) return;

                const { invoke } = await tauriCore();
                const files: File[] = [];
                for (const p of paths) {
                    try {
                        const bytes = await invoke<number[]>("read_file_bytes", {
                            path: p,
                        });
                        const name = basenameOf(p);
                        const dot = name.lastIndexOf(".");
                        const ext = dot >= 0 ? name.slice(dot + 1) : "bin";
                        const blob = new Blob(
                            [new Uint8Array(bytes)],
                            { type: mimeFromExt(ext) },
                        );
                        files.push(new File([blob], name, { type: blob.type }));
                    } catch (err) {
                        console.error("[image-drop] read failed", p, err);
                    }
                }
                if (files.length) await insertImagesSequential(store, files);
            });
            promise.then((fn) => {
                if (cancelled) fn();
                else cleanup = fn;
            });
        });

        return () => {
            cancelled = true;
            cleanup?.();
        };
    }, [store]);
}

export function ImageDropHandler(): null {
    useImageDrop();
    return null;
}
