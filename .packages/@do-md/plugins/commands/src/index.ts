/**
 * @do-md/commands — named editing commands for the @do-md/core-react kernel.
 *
 * The kernel ships mechanism: a markdown model with stable span identities,
 * absolute-offset addressing (`getSelectionOffsets` / `replaceRanges` /
 * `setSelection`), inline marks, and undo. It deliberately ships no opinion
 * about what "make this a bulleted list" means. That opinion lives here, the
 * way prosemirror-schema-list sits beside prosemirror-model.
 *
 * Everything exported is a plain function `fn(store, ...args)` over the public
 * `EditorStoreApi` — no React, no DOM, no UI framework, no reach into the
 * kernel's internals. Commands are safe to call with a null store or with no
 * caret placed; they simply do nothing, which is what lets a host wire a
 * button up before it knows whether the editor is ready.
 *
 * Each command is exactly one `replaceRanges` batch, so it is one undo step,
 * emits ordinary fine-grained ops to collaborators, and leaves untouched spans
 * with their identity intact — a menu click is indistinguishable from the user
 * typing the markers by hand.
 */

export {
    EMPTY_BLOCK_FORMAT_STATE,
    clearFormatting,
    insertDivider,
    insertLink,
    readBlockFormatState,
    setParagraphStyle,
    toggleBulletList,
    toggleCodeBlock,
    toggleList,
    toggleOrderedList,
    toggleQuote,
    toggleTodoList,
    type BlockFormatState,
} from "./block-format";

export { insertTable } from "./insert";

export {
    EDITOR_SHORTCUTS,
    attachKeyboardCommands,
    isApplePlatform,
    matchCommandShortcut,
    runCommand,
    shortcutLabel,
    type CommandShortcut,
    type EditorCommandId,
    type KeyboardCommandOptions,
    type KeyboardCommandTarget,
    type ShortcutMatchOptions,
} from "./keymap";

/** The pure markdown line algebra the block commands are built on. Exported
 *  because it is useful on its own — a host writing its own command can parse
 *  and rebuild a line prefix without re-deriving the rules. */
export {
    buildPrefix,
    fenceMap,
    lineGuards,
    lineIndexAt,
    linesInRange,
    offsetOfLine,
    parseLine,
    prefixLength,
    stripInlineMarks,
    type HeadingLevel,
    type LineGuard,
    type LinePrefix,
    type LineRange,
    type ListKind,
} from "./line-format";
