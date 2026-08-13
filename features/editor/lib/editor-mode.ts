/**
 * Editor display mode — a per-user VIEW preference, not document state.
 * Kernel semantics (see @do-md/core-react EditorMode): "markdown" reveals
 * syntax symbols when the caret is adjacent (Typora-style), "rich" never
 * reveals them. Model and round-trip are identical across modes. Persisted
 * in localStorage so the choice survives reloads and new windows.
 *
 * The Cmd+/ (Ctrl+/) toggle deliberately lives OUTSIDE the FORMAT_SHORTCUTS
 * registry: that registry is the Aa menu's — every entry there is a format
 * command with a menu row and a parity test asserting both. Mode switching
 * is a view command with its own surface (the "more" menu). The platform
 * discipline is the same though: the primary modifier is ⌘ on Apple
 * platforms and Ctrl elsewhere, and the foreign modifier must reject
 * (Ctrl+/ on macOS or Win+/ on Windows belong to the OS, not to us).
 */
import type { EditorMode, EditorStoreApi } from "@do-md/core-react";

export type { EditorMode };

const STORAGE_KEY = "domd:editor-mode";

export const MODE_TOGGLE_SHORTCUT = { mac: "⌘/", other: "Ctrl+/" } as const;

export function loadEditorMode(): EditorMode {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw === "markdown" ? "markdown" : "rich";
    } catch {
        return "rich";
    }
}

export function saveEditorMode(mode: EditorMode): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // Storage unavailable (private mode etc.) — the toggle still works,
        // it just will not survive a reload.
    }
}

/** True when the keystroke is this app's mode toggle. Matching is on
 *  `KeyboardEvent.code` ("Slash" on every layout) with an exact modifier
 *  set, mirroring matchFormatShortcut's discipline. */
export function matchModeToggleShortcut(
    event: Pick<
        KeyboardEvent,
        "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
    >,
    { mac }: { mac: boolean },
): boolean {
    const primary = mac ? event.metaKey : event.ctrlKey;
    const foreign = mac ? event.ctrlKey : event.metaKey;
    if (!primary || foreign) return false;
    return event.code === "Slash" && !event.shiftKey && !event.altKey;
}

/** The single toggle implementation — the menu item and the keystroke call
 *  this same function, so click and shortcut cannot diverge. */
export function toggleEditorMode(
    store: EditorStoreApi,
    current: EditorMode,
): void {
    const next: EditorMode = current === "rich" ? "markdown" : "rich";
    store.setMode(next);
    saveEditorMode(next);
}
