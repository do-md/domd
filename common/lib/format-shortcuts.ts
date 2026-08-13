/**
 * One registry for the "Aa" menu's keyboard shortcuts: the hint printed beside
 * a menu row and the key combination that fires it come from the same entry,
 * so the two can never drift apart.
 *
 * Matching is on `KeyboardEvent.code`, not `key` — with Shift held, `key` for
 * the 9 key is "(" on a US layout (and something else again elsewhere), while
 * `code` stays "Digit9" on every layout.
 */

export type FormatCommandId =
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "highlight"
    | "title"
    | "heading"
    | "subheading"
    | "body"
    | "checklist"
    | "blockQuote"
    | "codeBlock"
    | "link"
    | "clearFormatting";

export interface FormatShortcut {
    /** Physical key, matched against `KeyboardEvent.code`. */
    code: string;
    shift?: boolean;
    alt?: boolean;
    /** macOS glyph form, in Apple's canonical modifier order (⌃⌥⇧⌘). */
    mac: string;
    /** Windows/Linux spelling. */
    other: string;
}

export const FORMAT_SHORTCUTS: Record<FormatCommandId, FormatShortcut> = {
    // ⌘B/⌘I/⌘U are the browser's native contentEditable bold/italic/underline
    // until we claim them. That default is actively wrong here: it runs
    // execCommand, which writes <b>/<i>/<u> the kernel's model never sees, and
    // tracks its own on/off state — which is exactly why pressing ⌘B twice
    // used to leave you still bold while the toolbar button toggled off. We
    // bind them and preventDefault so both routes call the same format().
    bold: { code: "KeyB", mac: "⌘B", other: "Ctrl+B" },
    italic: { code: "KeyI", mac: "⌘I", other: "Ctrl+I" },
    underline: { code: "KeyU", mac: "⌘U", other: "Ctrl+U" },
    strikethrough: { code: "KeyX", shift: true, mac: "⇧⌘X", other: "Ctrl+Shift+X" },
    highlight: { code: "KeyH", shift: true, mac: "⇧⌘H", other: "Ctrl+Shift+H" },
    title: { code: "Digit1", mac: "⌘1", other: "Ctrl+1" },
    heading: { code: "Digit2", mac: "⌘2", other: "Ctrl+2" },
    subheading: { code: "Digit3", mac: "⌘3", other: "Ctrl+3" },
    body: { code: "Digit0", mac: "⌘0", other: "Ctrl+0" },
    checklist: { code: "KeyL", shift: true, mac: "⇧⌘L", other: "Ctrl+Shift+L" },
    blockQuote: { code: "Digit9", shift: true, mac: "⇧⌘9", other: "Ctrl+Shift+9" },
    codeBlock: { code: "KeyC", alt: true, mac: "⌥⌘C", other: "Ctrl+Alt+C" },
    link: { code: "KeyK", mac: "⌘K", other: "Ctrl+K" },
    clearFormatting: { code: "Backslash", mac: "⌘\\", other: "Ctrl+\\" },
};

/**
 * Commands withheld from the UI while their interaction is reworked. Parking
 * them HERE rather than just dropping the menu rows keeps the two halves in
 * step: a hidden command must not stay reachable by keystroke, or the feature
 * is only half-hidden. The implementations stay in place and under test — to
 * bring one back, delete it from this set and re-add its <MenuRow>.
 */
export const HIDDEN_COMMANDS: ReadonlySet<FormatCommandId> = new Set([
    "codeBlock",
    "link",
]);

/**
 * Shortcuts the KERNEL already binds on the editable element — we render the
 * hint but must not handle them, or the command runs twice.
 *
 * @do-md/core-react 0.9.2 handles ⌘0-⌘6 → `setHeaderLevel(n)`, whose semantics
 * match this app's `setParagraphStyle` exactly (verified: radio not toggle,
 * and list/quote markers are preserved, so `- item` becomes `- ## item`). Menu
 * row and keystroke therefore agree, and the kernel stays the single owner.
 *
 * The kernel also binds ⌘T (insertTable), ⇧⌘C (insertCodeArea), ⌘Z, ⌘A — none
 * of which this menu offers, so they need no entry here.
 */
export const KERNEL_OWNED_COMMANDS: ReadonlySet<FormatCommandId> = new Set([
    "title",
    "heading",
    "subheading",
    "body",
]);

/** True on Apple platforms, where the modifier is ⌘ rather than Ctrl.
 *
 *  `navigator.platform` is deprecated and increasingly frozen or spoofed, so
 *  the modern `userAgentData.platform` ("macOS" / "Windows" / "Linux") wins
 *  when the browser exposes it. SSR (`output: "export"`) has no navigator at
 *  all, so the prerender takes the non-Mac spelling and hydration corrects it. */
export function isApplePlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const uaData = (
        navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData;
    if (uaData?.platform) return /mac/i.test(uaData.platform);
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

export function shortcutLabel(id: FormatCommandId, mac: boolean): string {
    const shortcut = FORMAT_SHORTCUTS[id];
    return mac ? shortcut.mac : shortcut.other;
}

/**
 * Which command THIS APP should run for a keystroke. Returns null for a
 * shortcut that is merely displayed — hidden commands, and the ones the kernel
 * already owns — so the hint stays visible while the app keeps its hands off.
 *
 * `mac` is REQUIRED rather than sniffed here, because the platform decides
 * which modifier is the real one and accepting "either" is wrong on both
 * sides. On macOS, Ctrl+B / Ctrl+K / Ctrl+U are system-wide emacs text
 * bindings (backward-char, kill-to-end-of-line, kill-line) that work in every
 * text field — claiming them would break editing for anyone who uses them. On
 * Windows the mirror image applies: Meta is the Windows key, and Win+<letter>
 * belongs to the OS shell, not to us.
 */
export function matchFormatShortcut(
    event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
    { mac }: { mac: boolean },
): FormatCommandId | null {
    const primary = mac ? event.metaKey : event.ctrlKey;
    const foreign = mac ? event.ctrlKey : event.metaKey;
    if (!primary || foreign) return null;
    for (const [key, shortcut] of Object.entries(FORMAT_SHORTCUTS)) {
        if (event.code !== shortcut.code) continue;
        if (Boolean(shortcut.shift) !== event.shiftKey) continue;
        if (Boolean(shortcut.alt) !== event.altKey) continue;
        const id = key as FormatCommandId;
        if (HIDDEN_COMMANDS.has(id) || KERNEL_OWNED_COMMANDS.has(id)) return null;
        return id;
    }
    return null;
}
