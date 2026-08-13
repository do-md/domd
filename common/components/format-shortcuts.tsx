"use client";

/**
 * Binds the "Aa" menu's keyboard shortcuts. Renders nothing — same bridge
 * pattern as TitlebarInsertBridge, and it must sit inside a DOMDProvider to
 * reach the store.
 *
 * Mounted for BOTH runtimes on purpose: the web top bar carries the menu, the
 * desktop build has no web top bar at all, and the shortcuts are the only way
 * to reach these commands there.
 *
 * The most important job here is CLAIMING ⌘B/⌘I/⌘U. Left alone, the browser
 * services them itself on a contentEditable element via execCommand, which
 * writes <b>/<i>/<u> nodes the kernel's model knows nothing about and keeps
 * its own idea of whether the mark is on. Routing them through `format()`
 * instead makes the keystroke and the toolbar button literally the same call.
 *
 * Caveat worth knowing: ⌘1-⌘3 / ⌘0 select browser tabs in Chrome and Safari,
 * and a page cannot preventDefault a browser-level shortcut. Those are the
 * kernel's bindings, not ours (see KERNEL_OWNED_COMMANDS); they work in the
 * Tauri build, where there is no tab strip, and in a browser tab the menu rows
 * remain the reliable path.
 */

import { useEditorStoreApi } from "@do-md/core-react";
import { useEffect } from "react";
import {
    clearFormatting,
    insertLink,
    setParagraphStyle,
    toggleCodeBlock,
    toggleList,
    toggleQuote,
} from "@/common/lib/editor-block-format";
import {
    matchFormatShortcut,
    type FormatCommandId,
} from "@/common/lib/format-shortcuts";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";
import type { EditorStoreApi } from "@do-md/core-react";

/** Every command has an entry, but `matchFormatShortcut` only yields the ones
 *  this app owns — HIDDEN_COMMANDS (⌘K / ⌥⌘C, parked) and KERNEL_OWNED_COMMANDS
 *  (⌘0-⌘6, handled by the kernel itself) never arrive here. Keeping their
 *  handlers means changing owner is a single edit to those sets.
 *
 *  Character styles route through the SAME `format(mark)` the toolbar buttons
 *  call, so keystroke and click cannot diverge: collapsed caret arms the mark
 *  (next typing is bold) and a second press disarms; a range selection wraps
 *  and unwraps. */
const COMMANDS: Record<FormatCommandId, (store: EditorStoreApi) => void> = {
    bold: (store) => store.format("bold"),
    italic: (store) => store.format("italic"),
    underline: (store) => store.format("underline"),
    strikethrough: (store) => store.format("strike"),
    highlight: (store) => store.format("highlight"),
    title: (store) => setParagraphStyle(store, 1),
    heading: (store) => setParagraphStyle(store, 2),
    subheading: (store) => setParagraphStyle(store, 3),
    body: (store) => setParagraphStyle(store, 0),
    checklist: (store) => toggleList(store, "todo"),
    blockQuote: (store) => toggleQuote(store),
    codeBlock: (store) => toggleCodeBlock(store),
    link: (store) => insertLink(store),
    clearFormatting: (store) => clearFormatting(store),
};

/** Keystrokes aimed at a text field belong to that field, not the document. */
function isFormField(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element?.tagName) return false;
    const tag = element.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
}

export function FormatShortcuts() {
    const storeApi = useEditorStoreApi();
    const mac = useApplePlatform();

    useEffect(() => {
        if (!storeApi) return;
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || isFormField(event.target)) return;
            const command = matchFormatShortcut(event, { mac });
            if (!command) return;
            // Claim the key only when there is actually something to act on:
            // with no caret (or in a read-only viewer) the browser's own
            // binding should still work.
            if (!storeApi.isEditable || !storeApi.startCursorInfo) return;
            event.preventDefault();
            COMMANDS[command](storeApi);
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [storeApi, mac]);

    return null;
}
