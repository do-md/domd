"use client";

/**
 * Top-bar「格式」dropdown (Apple Notes "Aa" popover): character styles,
 * paragraph styles, lists, and the block entries that don't fit either.
 *
 * Two different state sources, on purpose:
 *   - Inline marks come from the kernel's STATE-FIRST surface, `useFormatState()`
 *     — reactive { active, can } per mark, no command-style isActive()/can()
 *     queries — and are applied with `format(mark)` against the MODEL
 *     selection, which survives the editor losing DOM focus to the click.
 *   - Block styles have no kernel command API, so they are derived from the
 *     markdown source by @do-md/commands. That costs a full `toMarkdown()`,
 *     which is far too expensive for a render path, so the snapshot is taken
 *     when the popover OPENS and refreshed after each action.
 *
 * Self-contained like InsertToolbar: works anywhere inside a DOMDProvider.
 */

import {
    useEditorStore,
    useEditorStoreApi,
    useFormatState,
    type InlineFormatMark,
} from "@do-md/core-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    clearFormatting,
    insertDivider,
    readBlockFormatState,
    setParagraphStyle,
    shortcutLabel,
    toggleList,
    toggleQuote,
    EMPTY_BLOCK_FORMAT_STATE,
    type BlockFormatState,
    type HeadingLevel,
    type ListKind,
} from "@do-md/commands";
import { type FormatCommandId } from "@/common/lib/format-shortcuts";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";

const MARK_BUTTONS: Array<{
    mark: InlineFormatMark;
    /** Doubles as the i18n key and the shortcut-registry id — they are kept
     *  deliberately identical so a row can't show one label's shortcut. */
    command: FormatCommandId & ("bold" | "italic" | "underline" | "strikethrough" | "highlight");
    glyph: React.ReactNode;
    /** Pressed-state classes. Highlight shows its own colour rather than the
     *  generic accent — the button previews the mark it applies. */
    activeClassName?: string;
}> = [
    { mark: "bold", command: "bold", glyph: <span className="font-bold">B</span> },
    { mark: "italic", command: "italic", glyph: <span className="italic">I</span> },
    { mark: "underline", command: "underline", glyph: <span className="underline">U</span> },
    { mark: "strike", command: "strikethrough", glyph: <span className="line-through">S</span> },
    {
        mark: "highlight",
        command: "highlight",
        glyph: <span>H</span>,
        activeClassName: "btn-active bg-warning/30 border-warning/40 text-base-content",
    },
];

/** Paragraph styles preview their own typography, the way Notes does — the
 *  row for 标题 is set in the heading's weight and size so the menu shows what
 *  it does rather than describing it. */
const PARAGRAPH_STYLES: Array<{
    level: HeadingLevel;
    labelKey: string;
    command: FormatCommandId;
    className: string;
}> = [
    { level: 1, labelKey: "title", command: "title", className: "text-xl font-semibold" },
    { level: 2, labelKey: "heading", command: "heading", className: "text-lg font-semibold" },
    { level: 3, labelKey: "subheading", command: "subheading", className: "text-base font-semibold" },
    { level: 0, labelKey: "body", command: "body", className: "text-sm" },
];

/** No checklist row: the top bar already carries a dedicated checklist button
 *  (InsertToolbar), and duplicating it here buys nothing. ⇧⌘L still works —
 *  the command is live, it just isn't listed twice. */
const LIST_STYLES: Array<{
    kind: ListKind;
    labelKey: string;
    glyph: string;
    command?: FormatCommandId;
}> = [
    { kind: "bullet", labelKey: "bulletedList", glyph: "•" },
    { kind: "ordered", labelKey: "numberedList", glyph: "1." },
];

function CheckIcon() {
    return (
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
            <path
                d="M3 8.5 6.2 11.5 13 4.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ChevronIcon() {
    return (
        <svg viewBox="0 0 16 16" className="size-2.5" fill="none" aria-hidden="true">
            <path
                d="M4 6.5 8 10.5 12 6.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/**
 * The character-style row gives each of its five buttons roughly 45px, which
 * fits a Mac glyph cluster ("⌘B", "⇧⌘X") and the short Windows forms
 * ("Ctrl+B") but not the long ones ("Ctrl+Shift+X"). Rather than truncate a
 * shortcut — a half-shown key combination is worse than none — the caption is
 * dropped past this budget and the shortcut survives on the button's tooltip
 * and `aria-keyshortcuts`, which have no width limit. The full-width menu rows
 * below always spell it out.
 */
const INLINE_CAPTION_MAX_CHARS = 7;

/**
 * Every control in this menu acts on the editor's CURRENT selection, so the
 * click must not move focus out of the document first. Both events are
 * cancelled: suppressing `pointerdown` should already suppress the
 * compatibility `mousedown`, but that only holds where the pointer events are
 * the primary ones — pen/touch fallbacks and synthetic clicks still deliver a
 * bare `mousedown`, which is what actually moves focus.
 */
const keepSelection = {
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
} as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-2 pt-1.5 pb-1 text-xs text-base-content/40 select-none">
            {children}
        </div>
    );
}

function Separator() {
    return <div aria-hidden className="my-1 h-px bg-base-content/10" />;
}

/** One selectable row: fixed check gutter, flexible label, trailing shortcut
 *  hint. The gutter is always reserved so labels line up whether or not a row
 *  is currently active. */
function MenuRow({
    label,
    labelClassName = "text-sm",
    glyph,
    active = false,
    disabled = false,
    shortcut,
    onSelect,
}: {
    label: string;
    labelClassName?: string;
    glyph?: string;
    active?: boolean;
    disabled?: boolean;
    shortcut?: string;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            role="menuitemradio"
            aria-checked={active}
            disabled={disabled}
            title={label}
            className={
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors " +
                (disabled
                    ? "opacity-35 cursor-not-allowed"
                    : "hover:bg-base-content/10 active:bg-base-content/15 cursor-pointer")
            }
            {...keepSelection}
            onClick={onSelect}
        >
            <span className="w-3.5 shrink-0 text-primary">
                {active ? <CheckIcon /> : null}
            </span>
            {glyph ? (
                <span className="w-4 shrink-0 text-center text-sm text-base-content/70">
                    {glyph}
                </span>
            ) : null}
            <span className={"flex-1 truncate leading-tight " + labelClassName}>
                {label}
            </span>
            {shortcut ? (
                <span className="shrink-0 text-xs text-base-content/35 tabular-nums">
                    {shortcut}
                </span>
            ) : null}
        </button>
    );
}

export function FormatDropdown({ className = "" }: { className?: string }) {
    const { t } = useTranslation();
    const storeApi = useEditorStoreApi();
    const formatState = useFormatState();
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const [open, setOpen] = useState(false);
    const [blockState, setBlockState] = useState<BlockFormatState>(
        EMPTY_BLOCK_FORMAT_STATE,
    );

    // Whether the menu has anything to act on, decided BEFORE it opens — a
    // popover whose every row is greyed out makes the user pay a click to
    // learn nothing (Notes disables the "Aa" control itself instead).
    // `startCursorInfo` is reactive and free to read, unlike the block-format
    // snapshot below, which costs a full toMarkdown() and so is only taken on
    // open. The two agree: `readBlockFormatState` also reports unavailable
    // without a cursor.
    const canFormat = useEditorStore(
        (store) => store.isEditable && store.startCursorInfo !== null,
    );

    const isMac = useApplePlatform();
    const shortcutFor = useCallback(
        (id?: FormatCommandId) => (id ? shortcutLabel(id, isMac) : undefined),
        [isMac],
    );

    const refreshBlockState = useCallback(() => {
        setBlockState(readBlockFormatState(storeApi));
    }, [storeApi]);

    const close = useCallback(() => setOpen(false), []);

    // `open` is CONTROLLED (see the <details open={isOpen}> below) and gated on
    // canFormat, so losing the cursor mid-popover closes it as a plain render
    // — no effect syncing state back to itself. React writing open=false still
    // fires a native toggle event, so onToggle re-settles the state too.
    const isOpen = open && canFormat;

    // <details> has no outside-click behaviour of its own, and a popover this
    // large stranded open would swallow the page.
    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!detailsRef.current?.contains(e.target as Node)) close();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [isOpen, close]);

    /** Every entry dismisses the popover, character styles included — that is
     *  how the Notes "Aa" popover behaves, and it keeps one click = one
     *  visible outcome. */
    const runAction = useCallback(
        (action: () => void) => {
            action();
            close();
        },
        [close],
    );

    // Block entries need a line that is prose, not structure: on a table row,
    // a `---` rule or inside a code fence they would corrupt the document, so
    // they go dead rather than silently mangling it.
    const disabled = !blockState.available;
    const blockDisabled = disabled || blockState.guard !== null;

    return (
        <details
            ref={detailsRef}
            open={isOpen}
            className={`dropdown dropdown-center ${className}`}
            onToggle={(e) => {
                const nowOpen = (e.currentTarget as HTMLDetailsElement).open && canFormat;
                setOpen(nowOpen);
                if (nowOpen) refreshBlockState();
            }}
        >
            <summary
                className={
                    "btn btn-xs list-none gap-1 " +
                    (!canFormat
                        ? "btn-disabled btn-ghost"
                        : isOpen
                          ? "btn-active btn-primary"
                          : "btn-ghost text-base-content/60")
                }
                title={t("editor.format.button")}
                aria-label={t("editor.format.button")}
                // <summary> takes no `disabled`, so the open has to be refused
                // here: preventing the click is what stops <details> toggling.
                aria-disabled={!canFormat}
                tabIndex={canFormat ? undefined : -1}
                onClick={(e) => {
                    if (!canFormat) e.preventDefault();
                }}
                {...keepSelection}
            >
                Aa
                <ChevronIcon />
            </summary>

            <div
                role="menu"
                // `text-base-content text-sm` is NOT decoration: the popover
                // renders inside the top bar, which is `text-xs
                // text-base-content/50` toolbar chrome, and colour inherits.
                // Without its own colour every enabled row — and every ghost
                // mark button, since daisyUI resolves `--btn-fg` to
                // currentColor — paints at 50% and reads as disabled. A
                // floating surface states its own text style.
                //
                // No z-* utility here on purpose: daisyUI's own z-999 is
                // right, and a Tailwind z-30 would silently LOWER it.
                // Elevation above the document is the top bar's job (z-40).
                className="dropdown-content mt-1 w-60 rounded-box border border-base-content/15 bg-base-100 p-1.5 text-sm text-base-content shadow-lg"
            >
                <SectionLabel>{t("editor.format.characterStyle")}</SectionLabel>
                <div className="flex items-start justify-around px-1 pb-1">
                    {MARK_BUTTONS.map(({ mark, command, glyph, activeClassName }) => {
                        const { active, can } = formatState[mark];
                        const label = t(`editor.format.${command}`);
                        const shortcut = shortcutFor(command);
                        return (
                            <div
                                key={mark}
                                className="flex flex-col items-center gap-0.5"
                            >
                                <button
                                    type="button"
                                    role="menuitemcheckbox"
                                    className={
                                        "btn btn-sm btn-square " +
                                        (active
                                            ? (activeClassName ?? "btn-active btn-primary")
                                            : "btn-ghost")
                                    }
                                    disabled={!can}
                                    aria-label={label}
                                    aria-keyshortcuts={shortcut}
                                    aria-checked={active}
                                    title={shortcut ? `${label}  ${shortcut}` : label}
                                    {...keepSelection}
                                    onClick={() => runAction(() => storeApi?.format(mark))}
                                >
                                    {glyph}
                                </button>
                                <span
                                    aria-hidden
                                    className="text-[10px] leading-none text-base-content/35 tabular-nums"
                                >
                                    {shortcut && shortcut.length <= INLINE_CAPTION_MAX_CHARS
                                        ? shortcut
                                        : ""}
                                </span>
                            </div>
                        );
                    })}
                </div>

                <Separator />
                <SectionLabel>{t("editor.format.paragraphStyle")}</SectionLabel>
                {PARAGRAPH_STYLES.map(({ level, labelKey, command, className: styleClass }) => (
                    <MenuRow
                        key={labelKey}
                        label={t(`editor.format.${labelKey}`)}
                        labelClassName={styleClass}
                        active={blockState.heading === level}
                        disabled={blockDisabled}
                        shortcut={shortcutFor(command)}
                        onSelect={() =>
                            runAction(() => setParagraphStyle(storeApi, level))
                        }
                    />
                ))}

                <Separator />
                <SectionLabel>{t("editor.format.lists")}</SectionLabel>
                {LIST_STYLES.map(({ kind, labelKey, glyph, command }) => (
                    <MenuRow
                        key={kind}
                        label={t(`editor.format.${labelKey}`)}
                        glyph={glyph}
                        active={blockState[kind]}
                        disabled={blockDisabled}
                        shortcut={shortcutFor(command)}
                        onSelect={() => runAction(() => toggleList(storeApi, kind))}
                    />
                ))}

                {/* Code Block and Link are withheld pending UX fixes — see
                    HIDDEN_COMMANDS in common/lib/format-shortcuts.ts, which
                    also parks their keyboard shortcuts so the two can't drift
                    out of step. The actions themselves stay implemented and
                    under test; restoring a row is a one-line change. */}
                <Separator />
                <MenuRow
                    label={t("editor.format.blockQuote")}
                    active={blockState.quote}
                    disabled={blockDisabled}
                    shortcut={shortcutFor("blockQuote")}
                    onSelect={() => runAction(() => toggleQuote(storeApi))}
                />
                <MenuRow
                    label={t("editor.format.divider")}
                    disabled={blockDisabled}
                    onSelect={() => runAction(() => insertDivider(storeApi))}
                />

                <Separator />
                <MenuRow
                    label={t("editor.format.clearFormatting")}
                    disabled={blockDisabled}
                    shortcut={shortcutFor("clearFormatting")}
                    onSelect={() => runAction(() => clearFormatting(storeApi))}
                />
            </div>
        </details>
    );
}
