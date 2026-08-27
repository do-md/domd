// Desktop-only: the native "Aa" format menu.
//
// The native titlebar's Aa button (src-tauri/src/titlebar.rs) pulls its menu
// from here: on `titlebar-format-request` the bridge snapshots the SAME two
// state sources the web FormatDropdown reads — the kernel's reactive
// formatState for inline marks and @do-md/commands' readBlockFormatState for
// block styles (a full toMarkdown(), taken at open time by design) — and
// sends a finished menu description (runtime-i18n labels, structural
// shortcuts, enabled/active flags) to the `show_format_menu` command, which
// renders it as a real NSMenu. Item clicks come back as
// `titlebar-format-command` with an id, dispatched below through the very
// same command-layer functions the web menu rows call.

import type {
    EditorStoreApi,
    FormatState,
    InlineFormatMark,
} from "@do-md/core-react";
import {
    EDITOR_SHORTCUTS,
    clearFormatting,
    insertDivider,
    readBlockFormatState,
    setParagraphStyle,
    toggleList,
    toggleQuote,
    type EditorCommandId,
    type HeadingLevel,
    type ListKind,
} from "@do-md/commands";

/** Mirror of the Rust `FormatMenuEntry` (serde: tag = "kind", camelCase). */
export type NativeFormatMenuEntry =
    | { kind: "section"; label: string }
    | { kind: "separator" }
    | {
          kind: "item";
          id: string;
          label: string;
          enabled?: boolean;
          active?: boolean;
          /** ⌘-based key equivalent, display-only (see titlebar.rs). */
          key?: string;
          shift?: boolean;
          alt?: boolean;
      };

const MARK_ITEMS: Array<{
    mark: InlineFormatMark;
    /** i18n key AND shortcut-registry id AND dispatch id — deliberately one
     *  name so a row can't show another row's shortcut (FormatDropdown's
     *  discipline). */
    command: EditorCommandId &
        ("bold" | "italic" | "underline" | "strikethrough" | "highlight");
}> = [
    { mark: "bold", command: "bold" },
    { mark: "italic", command: "italic" },
    { mark: "underline", command: "underline" },
    { mark: "strike", command: "strikethrough" },
    { mark: "highlight", command: "highlight" },
];

const PARAGRAPH_ITEMS: Array<{
    level: HeadingLevel;
    command: EditorCommandId & ("title" | "heading" | "subheading" | "body");
}> = [
    { level: 1, command: "title" },
    { level: 2, command: "heading" },
    { level: 3, command: "subheading" },
    { level: 0, command: "body" },
];

/** No checklist row — the titlebar carries a dedicated checklist button,
 *  same reasoning as the web dropdown. */
const LIST_ITEMS: Array<{ kind: ListKind; labelKey: string }> = [
    { kind: "bullet", labelKey: "bulletedList" },
    { kind: "ordered", labelKey: "numberedList" },
];

/** KeyboardEvent.code -> NSMenuItem key equivalent character. */
function keyEquivalentFor(code: string): string | undefined {
    if (code.startsWith("Key")) return code.slice(3).toLowerCase();
    if (code.startsWith("Digit")) return code.slice(5);
    if (code === "Backslash") return "\\";
    return undefined;
}

function shortcutFields(
    id: EditorCommandId,
): Pick<Extract<NativeFormatMenuEntry, { kind: "item" }>, "key" | "shift" | "alt"> {
    const shortcut = EDITOR_SHORTCUTS[id];
    const key = shortcut ? keyEquivalentFor(shortcut.code) : undefined;
    if (!key) return {};
    return { key, shift: shortcut.shift ?? false, alt: shortcut.alt ?? false };
}

/**
 * Build the full menu description. Mirrors the web FormatDropdown row for
 * row: character styles, paragraph styles, lists, quote/divider, clear
 * formatting. Code Block and Link stay withheld (HIDDEN_COMMANDS) — they are
 * simply not listed here, keeping the two surfaces in step.
 */
export function buildFormatMenuEntries({
    storeApi,
    formatState,
    t,
}: {
    storeApi: EditorStoreApi | null;
    formatState: FormatState;
    t: (key: string) => string;
}): NativeFormatMenuEntry[] {
    const blockState = readBlockFormatState(storeApi);
    // Same gating as the web menu: block entries need a prose line — on a
    // table row, a `---` rule or inside a code fence they would corrupt the
    // document, so they go dead rather than silently mangling it.
    const blockDisabled = !blockState.available || blockState.guard !== null;

    const entries: NativeFormatMenuEntry[] = [];

    entries.push({ kind: "section", label: t("editor.format.characterStyle") });
    for (const { mark, command } of MARK_ITEMS) {
        const { active, can } = formatState[mark];
        entries.push({
            kind: "item",
            id: command,
            label: t(`editor.format.${command}`),
            enabled: can,
            active,
            ...shortcutFields(command),
        });
    }

    entries.push({ kind: "section", label: t("editor.format.paragraphStyle") });
    for (const { level, command } of PARAGRAPH_ITEMS) {
        entries.push({
            kind: "item",
            id: command,
            label: t(`editor.format.${command}`),
            enabled: !blockDisabled,
            active: blockState.heading === level,
            ...shortcutFields(command),
        });
    }

    entries.push({ kind: "section", label: t("editor.format.lists") });
    for (const { kind, labelKey } of LIST_ITEMS) {
        entries.push({
            kind: "item",
            id: `list:${kind}`,
            label: t(`editor.format.${labelKey}`),
            enabled: !blockDisabled,
            active: blockState[kind],
        });
    }

    entries.push({ kind: "separator" });
    entries.push({
        kind: "item",
        id: "blockQuote",
        label: t("editor.format.blockQuote"),
        enabled: !blockDisabled,
        active: blockState.quote,
        ...shortcutFields("blockQuote"),
    });
    entries.push({
        kind: "item",
        id: "divider",
        label: t("editor.format.divider"),
        enabled: !blockDisabled,
    });

    entries.push({ kind: "separator" });
    entries.push({
        kind: "item",
        id: "clearFormatting",
        label: t("editor.format.clearFormatting"),
        enabled: !blockDisabled,
        ...shortcutFields("clearFormatting"),
    });

    return entries;
}

/** Dispatch a clicked menu item — the same command-layer calls the web menu
 *  rows make, so the two surfaces cannot diverge in behavior. */
export function runNativeFormatCommand(
    storeApi: EditorStoreApi | null,
    id: string,
): void {
    switch (id) {
        case "bold":
            storeApi?.format("bold");
            return;
        case "italic":
            storeApi?.format("italic");
            return;
        case "underline":
            storeApi?.format("underline");
            return;
        case "strikethrough":
            storeApi?.format("strike");
            return;
        case "highlight":
            storeApi?.format("highlight");
            return;
        case "title":
            setParagraphStyle(storeApi, 1);
            return;
        case "heading":
            setParagraphStyle(storeApi, 2);
            return;
        case "subheading":
            setParagraphStyle(storeApi, 3);
            return;
        case "body":
            setParagraphStyle(storeApi, 0);
            return;
        case "list:bullet":
            toggleList(storeApi, "bullet");
            return;
        case "list:ordered":
            toggleList(storeApi, "ordered");
            return;
        case "blockQuote":
            toggleQuote(storeApi);
            return;
        case "divider":
            insertDivider(storeApi);
            return;
        case "clearFormatting":
            clearFormatting(storeApi);
            return;
        default:
            console.warn("[native-format-menu] unknown command:", id);
    }
}
