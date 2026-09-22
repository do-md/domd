"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useEditorStoreApi } from "@do-md/core-react";

/**
 * True while the active document is still streaming into the model — the
 * kernel's chunked load (>500-line constructor / resetMDChunked) has more
 * lines to append, so `toMarkdown()` currently returns a PREFIX of the file.
 *
 * Everything that persists or re-parses the whole document must gate on this
 * (task-54474e): writing a prefix truncates the user's file on disk, and
 * `resetMD(toMarkdown())` mid-load makes that truncation permanent by
 * cancelling the rest of the load.
 *
 * useSyncExternalStore, not an effect: the kernel IS the external store here,
 * and the value must be correct on the very first render — a view that mounts
 * mid-load and reads `false` for one render is exactly the window in which an
 * autosave escapes. Degrades to "not loading" on kernels without the signal,
 * which is the pre-chunking behavior.
 */
export function useDocLoading(): boolean {
    const store = useEditorStoreApi();

    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!store?.subscribeLoadingChange) return () => {};
            return store.subscribeLoadingChange(onChange);
        },
        [store],
    );

    const getSnapshot = useCallback(
        () => store?.isLoadingChunks ?? false,
        [store],
    );

    return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
