"use client";
/**
 * Editor-mode controller: renders nothing (FormatShortcuts family, must sit
 * inside a DOMDProvider). Two jobs:
 *
 * 1. Hydrate the persisted mode on mount. The provider always starts in
 *    "rich" so SSR (`output: "export"`) and the first client render agree;
 *    the stored preference is applied right after (chat-app pattern).
 * 2. Bind Cmd+/ (Ctrl+/) to toggle rich <-> markdown, persisting the
 *    choice. Mounted for BOTH runtimes: the web "more" menu carries the
 *    visible entry, the desktop build has no web top bar — the keystroke is
 *    the desktop path.
 */
import { useEffect } from "react";
import { useEditorStore, useEditorStoreApi } from "@do-md/core-react";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";
import { useLatest } from "@/common/lib/use-latest";
import {
    loadEditorMode,
    matchModeToggleShortcut,
    toggleEditorMode,
} from "../lib/editor-mode";

/** Keystrokes aimed at a text field belong to that field, not the view. */
function isFormField(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element?.tagName) return false;
    const tag = element.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
}

export function ModeController() {
    const storeApi = useEditorStoreApi();
    const mode = useEditorStore((s) => s.mode);
    const modeRef = useLatest(mode);
    const mac = useApplePlatform();

    // Apply the persisted preference once the store materializes. Keyed on
    // storeApi so a document swap (provider remount) re-applies it.
    useEffect(() => {
        if (!storeApi) return;
        const saved = loadEditorMode();
        if (saved !== storeApi.mode) storeApi.setMode(saved);
    }, [storeApi]);

    useEffect(() => {
        if (!storeApi) return;
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || isFormField(event.target)) return;
            if (!matchModeToggleShortcut(event, { mac })) return;
            event.preventDefault();
            toggleEditorMode(storeApi, modeRef.current);
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [storeApi, mac, modeRef]);

    return null;
}
