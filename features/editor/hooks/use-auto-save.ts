"use client";
import { useEffect, useRef } from "react";
import type { useRenderData } from "@do-md/react";
import type { FileMeta } from "../lib/types";

type RenderData = ReturnType<typeof useRenderData>;

// Debounced auto-save for Tauri files with a known path. Skips the first
// renderData tick (initial content from initMd) so we don't immediately
// rewrite the freshly-opened file.
export function useAutoSave(
    meta: FileMeta,
    renderData: RenderData,
    doSave: (data: RenderData) => Promise<boolean>,
) {
    const seenInitialRef = useRef(false);
    const tauriPath = meta.kind === "tauri" ? meta.path : null;
    useEffect(() => {
        if (!seenInitialRef.current) {
            seenInitialRef.current = true;
            return;
        }
        if (!tauriPath) return;
        const id = setTimeout(() => doSave(renderData), 600);
        return () => clearTimeout(id);
    }, [renderData, tauriPath, doSave]);
}
