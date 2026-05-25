"use client";
import { useEffect } from "react";
import { isTauri } from "@/common/lib/platform";
import { tauriWebviewWindow } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";

// Subscribe to a Tauri WebviewWindow event. The handler is stored in a ref,
// so re-renders never re-mount the listener.
export function useTauriEvent<T = unknown>(
    event: string,
    handler: (payload: T) => void,
) {
    const handlerRef = useLatest(handler);

    useEffect(() => {
        if (!isTauri()) return;
        let cancelled = false;
        let unlisten: (() => void) | null = null;

        tauriWebviewWindow().then(({ getCurrentWebviewWindow }) => {
            if (cancelled) return;
            getCurrentWebviewWindow()
                .listen<T>(event, (e) => handlerRef.current(e.payload))
                .then((fn) => {
                    if (cancelled) fn();
                    else unlisten = fn;
                });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [event, handlerRef]);
}
