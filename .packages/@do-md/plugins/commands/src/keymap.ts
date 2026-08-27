/**
 * One registry for every command's keyboard shortcut: the hint a host prints
 * beside a menu row and the key combination that fires it come from the same
 * entry, so the two can never drift apart.
 *
 * Matching is on `KeyboardEvent.code`, not `key` — with Shift held, `key` for
 * the 9 key is "(" on a US layout (and something else again elsewhere), while
 * `code` stays "Digit9" on every layout.
 *
 * Ownership: the kernel binds only undo/redo, select-all, Enter/Tab and the
 * IME plumbing. Everything below is this layer's, including the ⌘0-⌘6 heading
 * levels and ⌘T that older kernels used to handle themselves — one keystroke,
 * one owner, and that owner calls the same function a button would.
 */

import type { EditorStoreApi } from "@do-md/core-react";
import {
    clearFormatting,
    insertLink,
    setParagraphStyle,
    toggleCodeBlock,
    toggleList,
    toggleQuote,
} from "./block-format";
import { insertTable } from "./insert";

export type EditorCommandId =
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "highlight"
    | "title"
    | "heading"
    | "subheading"
    | "heading4"
    | "heading5"
    | "heading6"
    | "body"
    | "checklist"
    | "blockQuote"
    | "codeBlock"
    | "link"
    | "clearFormatting"
    | "insertTable";

export interface CommandShortcut {
    /** Physical key, matched against `KeyboardEvent.code`. */
    code: string;
    shift?: boolean;
    alt?: boolean;
    /** macOS glyph form, in Apple's canonical modifier order (⌃⌥⇧⌘). */
    mac: string;
    /** Windows/Linux spelling. */
    other: string;
}

export const EDITOR_SHORTCUTS: Record<EditorCommandId, CommandShortcut> = {
    // ⌘B/⌘I/⌘U are the browser's native contentEditable bold/italic/underline
    // until they are claimed. That default is actively wrong here: it runs
    // execCommand, which writes <b>/<i>/<u> the kernel's model never sees, and
    // tracks its own on/off state — which is why pressing ⌘B twice leaves you
    // still bold while a toolbar button toggles off. Binding them and calling
    // preventDefault makes both routes call the same `format()`.
    bold: { code: "KeyB", mac: "⌘B", other: "Ctrl+B" },
    italic: { code: "KeyI", mac: "⌘I", other: "Ctrl+I" },
    underline: { code: "KeyU", mac: "⌘U", other: "Ctrl+U" },
    strikethrough: { code: "KeyX", shift: true, mac: "⇧⌘X", other: "Ctrl+Shift+X" },
    highlight: { code: "KeyH", shift: true, mac: "⇧⌘H", other: "Ctrl+Shift+H" },
    // ⌘1-⌘6 / ⌘0 select browser tabs in Chrome and Safari, and a page cannot
    // preventDefault a browser-level shortcut — these reach the document in a
    // desktop shell (Tauri/Electron), where there is no tab strip. In a
    // browser tab the menu rows remain the reliable path, which is why the
    // hint is still worth rendering.
    title: { code: "Digit1", mac: "⌘1", other: "Ctrl+1" },
    heading: { code: "Digit2", mac: "⌘2", other: "Ctrl+2" },
    subheading: { code: "Digit3", mac: "⌘3", other: "Ctrl+3" },
    heading4: { code: "Digit4", mac: "⌘4", other: "Ctrl+4" },
    heading5: { code: "Digit5", mac: "⌘5", other: "Ctrl+5" },
    heading6: { code: "Digit6", mac: "⌘6", other: "Ctrl+6" },
    body: { code: "Digit0", mac: "⌘0", other: "Ctrl+0" },
    checklist: { code: "KeyL", shift: true, mac: "⇧⌘L", other: "Ctrl+Shift+L" },
    blockQuote: { code: "Digit9", shift: true, mac: "⇧⌘9", other: "Ctrl+Shift+9" },
    codeBlock: { code: "KeyC", alt: true, mac: "⌥⌘C", other: "Ctrl+Alt+C" },
    link: { code: "KeyK", mac: "⌘K", other: "Ctrl+K" },
    clearFormatting: { code: "Backslash", mac: "⌘\\", other: "Ctrl+\\" },
    // Browser-reserved like the digits: ⌘T opens a tab. Kept because a desktop
    // shell delivers it, and because it is the binding users arriving from
    // older kernels already have in their fingers.
    insertTable: { code: "KeyT", mac: "⌘T", other: "Ctrl+T" },
};

/** What each command does. Character styles route through the SAME
 *  `format(mark)` a toolbar button calls, so keystroke and click cannot
 *  diverge: a collapsed caret arms the mark (the next typing is bold) and a
 *  second press disarms; a range selection wraps and unwraps. */
const COMMAND_HANDLERS: Record<
    EditorCommandId,
    (store: EditorStoreApi) => void
> = {
    bold: (store) => store.format("bold"),
    italic: (store) => store.format("italic"),
    underline: (store) => store.format("underline"),
    strikethrough: (store) => store.format("strike"),
    highlight: (store) => store.format("highlight"),
    title: (store) => setParagraphStyle(store, 1),
    heading: (store) => setParagraphStyle(store, 2),
    subheading: (store) => setParagraphStyle(store, 3),
    heading4: (store) => setParagraphStyle(store, 4),
    heading5: (store) => setParagraphStyle(store, 5),
    heading6: (store) => setParagraphStyle(store, 6),
    body: (store) => setParagraphStyle(store, 0),
    checklist: (store) => toggleList(store, "todo"),
    blockQuote: (store) => toggleQuote(store),
    codeBlock: (store) => toggleCodeBlock(store),
    link: (store) => insertLink(store),
    clearFormatting: (store) => clearFormatting(store),
    insertTable: (store) => insertTable(store),
};

/** Run a command by id — the same entry point the keymap uses, exposed so a
 *  menu, a command palette or a native menu item can share it. */
export function runCommand(
    store: EditorStoreApi | null,
    id: EditorCommandId,
): void {
    if (!store) return;
    COMMAND_HANDLERS[id](store);
}

/** True on Apple platforms, where the modifier is ⌘ rather than Ctrl.
 *
 *  `navigator.platform` is deprecated and increasingly frozen or spoofed, so
 *  the modern `userAgentData.platform` ("macOS" / "Windows" / "Linux") wins
 *  when the browser exposes it. Server rendering has no navigator at all, so a
 *  prerender takes the non-Mac spelling and hydration corrects it. */
export function isApplePlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const uaData = (
        navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData;
    if (uaData?.platform) return /mac/i.test(uaData.platform);
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

/** The printable form of a command's shortcut, for a menu hint or a tooltip. */
export function shortcutLabel(id: EditorCommandId, mac: boolean): string {
    const shortcut = EDITOR_SHORTCUTS[id];
    return mac ? shortcut.mac : shortcut.other;
}

export interface ShortcutMatchOptions {
    /**
     * Which modifier is the primary one. REQUIRED rather than sniffed, because
     * the platform decides which modifier is real and accepting "either" is
     * wrong on both sides. On macOS, Ctrl+B / Ctrl+K / Ctrl+U are system-wide
     * emacs text bindings (backward-char, kill-to-end-of-line, kill-line) that
     * work in every text field — claiming them would break editing for anyone
     * who uses them. On Windows the mirror image applies: Meta is the Windows
     * key, and Win+<letter> belongs to the OS shell.
     */
    mac: boolean;
    /**
     * Commands the host withholds — a feature parked pending a UX rework, or
     * one it services itself. A withheld command must not stay reachable by
     * keystroke, or it is only half-hidden: the menu row is gone but the key
     * still fires.
     */
    disabled?: ReadonlySet<EditorCommandId> | Iterable<EditorCommandId>;
}

function asSet(
    ids: ShortcutMatchOptions["disabled"],
): ReadonlySet<EditorCommandId> | null {
    if (!ids) return null;
    return ids instanceof Set ? ids : new Set(ids);
}

/** Which command a keystroke should run, or null for a keystroke this layer
 *  does not claim. */
export function matchCommandShortcut(
    event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
    options: ShortcutMatchOptions,
): EditorCommandId | null {
    const { mac } = options;
    const primary = mac ? event.metaKey : event.ctrlKey;
    const foreign = mac ? event.ctrlKey : event.metaKey;
    if (!primary || foreign) return null;
    const disabled = asSet(options.disabled);
    for (const [key, shortcut] of Object.entries(EDITOR_SHORTCUTS)) {
        if (event.code !== shortcut.code) continue;
        if (Boolean(shortcut.shift) !== event.shiftKey) continue;
        if (Boolean(shortcut.alt) !== event.altKey) continue;
        const id = key as EditorCommandId;
        return disabled?.has(id) ? null : id;
    }
    return null;
}

/** Anything that dispatches keydown — `window` in a browser, or a narrower
 *  element when the host wants the bindings scoped. */
export type KeyboardCommandTarget = Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
>;

export interface KeyboardCommandOptions extends Partial<ShortcutMatchOptions> {
    /** Defaults to `isApplePlatform()`. Pass it explicitly when the host
     *  already knows (e.g. it renders shortcut hints from the same value, and
     *  the two must agree). */
    mac?: boolean;
    /** Defaults to `window`. */
    target?: KeyboardCommandTarget | null;
}

/** Keystrokes aimed at a text field belong to that field, not the document.
 *  The editor itself is a contenteditable, not an <input>, so it is unaffected. */
function isFormField(target: EventTarget | null): boolean {
    const element = target as { tagName?: string } | null;
    if (!element?.tagName) return false;
    const tag = element.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
}

/**
 * Bind every command's shortcut to `store`. Returns a disposer; call it on
 * unmount.
 *
 * UI-free on purpose — a React host wraps this in one `useEffect`, a plain
 * page calls it directly. Nothing is rendered and no element is required.
 */
export function attachKeyboardCommands(
    store: EditorStoreApi | null,
    options: KeyboardCommandOptions = {},
): () => void {
    const noop = () => {};
    const view =
        options.target ?? (typeof window === "undefined" ? null : window);
    if (!store || !view) return noop;

    const mac = options.mac ?? isApplePlatform();
    const disabled = asSet(options.disabled) ?? undefined;

    const handler = ((event: KeyboardEvent) => {
        if (event.defaultPrevented || isFormField(event.target)) return;
        const id = matchCommandShortcut(event, { mac, disabled });
        if (!id) return;
        // Claim the key only when there is something to act on: with no caret
        // (or in a read-only viewer) the browser's own binding should still
        // work.
        if (!store.isEditable || !store.startCursorInfo) return;
        event.preventDefault();
        runCommand(store, id);
    }) as EventListener;

    view.addEventListener("keydown", handler);
    return () => view.removeEventListener("keydown", handler);
}
