"use client";
import { useEffect, useRef } from "react";
import type { useRenderData } from "@do-md/core-react";
import { useLatest } from "@/common/lib/use-latest";
import type { FileMeta } from "../lib/types";

type RenderData = ReturnType<typeof useRenderData>;

// Debounced auto-save for Tauri files with a known path. Skips the first
// renderData tick (initial content from the runtime) so we don't immediately
// rewrite the freshly-opened file.
//
// A pending save survives the view. The debounce timer dies with the editor's
// unmount — a tab switch, a document replacement — and the edit it was about
// to write exists nowhere but the runtime, so dropping it silently loses the
// last <600ms of typing. The unmount flush below writes it instead: doSave is
// self-contained (saveDocument needs no mounted editor), so firing it during
// teardown is safe.
export function useAutoSave(
    meta: FileMeta,
    renderData: RenderData,
    doSave: (data: RenderData) => Promise<boolean>,
    /** Unmount-time variant of doSave. Must not touch mounted-editor state:
     *  by the time it runs, the ACTIVE tab may already be a different one,
     *  so a path that reports meta back (doSave -> onMetaUpdate -> the
     *  active tab) would stamp the outgoing document's meta onto the
     *  incoming tab. Saving a path-backed file changes no meta, so the
     *  flush simply skips the report. */
    flushSave: (data: RenderData) => Promise<void>,
) {
    const seenInitialRef = useRef(false);
    /** The renderData a scheduled save has not written yet. Set when the
     *  timer arms, cleared when it fires — so at unmount it is exactly "the
     *  edit that would have been lost". */
    const pendingRef = useRef<RenderData | null>(null);
    const doSaveRef = useLatest(doSave);
    const flushSaveRef = useLatest(flushSave);
    const tauriPath = meta.kind === "tauri" ? meta.path : null;
    const tauriPathRef = useLatest(tauriPath);

    useEffect(() => {
        if (!seenInitialRef.current) {
            seenInitialRef.current = true;
            return;
        }
        if (!tauriPath) return;
        pendingRef.current = renderData;
        const id = setTimeout(() => {
            pendingRef.current = null;
            void doSaveRef.current(renderData);
        }, 600);
        return () => clearTimeout(id);
    }, [renderData, tauriPath, doSaveRef]);

    // Flush on unmount ONLY — not on every effect re-run, which would defeat
    // the debounce. The cleanup above cancels the timer per tick; this one
    // runs once, when the view goes away, and writes whatever is still owed.
    useEffect(
        () => () => {
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (pending && tauriPathRef.current) {
                void flushSaveRef.current(pending);
            }
        },
        [flushSaveRef, tauriPathRef],
    );
}
