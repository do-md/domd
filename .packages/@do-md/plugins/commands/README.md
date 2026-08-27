# @do-md/commands

Named editing commands for [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react), the DoMD markdown WYSIWYG editor kernel — the `prosemirror-schema-list` of DoMD.

The kernel deliberately ships **mechanisms only** (absolute-offset text replacement, selection addressing, a format engine). This package supplies the **named commands** a toolbar, keymap or command palette actually calls, built exclusively on the kernel's public API. Every command runs through the kernel's normal editing pipeline: one undo step per action, fine-grained ops for collaborators, and a result indistinguishable from the user typing the markdown by hand.

Pure functions of `(store, ...args)` — zero React, zero DOM rendering, zero runtime dependency on the kernel (types only).

## Install

```bash
npm install @do-md/commands @do-md/core-react
```

## Usage

```tsx
import { useEditorStoreApi } from "@do-md/core-react";
import {
    toggleBulletList,
    toggleOrderedList,
    toggleTodoList,
    toggleQuote,
    setParagraphStyle,
    readBlockFormatState,
    attachKeyboardCommands,
} from "@do-md/commands";

function Toolbar() {
    const store = useEditorStoreApi();

    // Read once when the menu opens (costs a full serialize — not per render)
    const state = readBlockFormatState(store);

    return (
        <>
            <button aria-pressed={state.bullet} onClick={() => toggleBulletList(store)}>•</button>
            <button aria-pressed={state.ordered} onClick={() => toggleOrderedList(store)}>1.</button>
            <button aria-pressed={state.todo} onClick={() => toggleTodoList(store)}>☑</button>
            <button aria-pressed={state.quote} onClick={() => toggleQuote(store)}>❝</button>
            <button onClick={() => setParagraphStyle(store, 1)}>H1</button>
        </>
    );
}

// Keyboard shortcuts (⌘T table, ⌘0–6 headings, ⇧⌘L todo list, …)
useEffect(() => attachKeyboardCommands(store), [store]);
```

## Commands

| | |
|---|---|
| `toggleBulletList` / `toggleOrderedList` / `toggleTodoList` / `toggleList(store, kind)` | Toggle a list flavour across the selection. Uniform selections toggle off; mixed ones convert to the requested flavour. |
| `toggleQuote` | Toggle one level of blockquote. |
| `toggleCodeBlock` | Wrap the selection in a fence, or unwrap the fence the caret sits in. |
| `setParagraphStyle(store, level)` | Heading level 1–6, or 0 for body. Radio semantics; list/quote markers survive. |
| `insertTable` | 2×2 table at the caret; fills an empty paragraph in place. |
| `insertDivider` | `---` after the caret's line, blank-line padding topped up automatically. |
| `insertLink` | Selection → `[text](url)` with `url` pre-selected; collapsed caret → `[](url)` with the caret between the brackets. |
| `clearFormatting` | Strip block markers and inline mark delimiters; links survive. |
| `readBlockFormatState` | Snapshot of heading/list/quote/code state at the selection, for menu checkmarks. |
| `attachKeyboardCommands(store, options?)` | Bind every command's shortcut; returns a disposer. |
| `runCommand(store, id)` / `matchCommandShortcut` / `EDITOR_SHORTCUTS` / `shortcutLabel` | Share the same command table with menus, palettes or native menu items. |

Structural lines defend themselves: commands refuse to rewrite table rows, `---` rules and fenced code rather than corrupt them (`readBlockFormatState().guard` tells a menu why entries are disabled).

The markdown-prefix helpers the commands are built from (`parseLine`, `buildPrefix`, `linesInRange`, `lineGuards`, …) are exported too.

## License

[MIT](./LICENSE). The editor kernel `@do-md/core-react` is licensed separately: GPL-3.0 with two additional permissions under section 7 (see the kernel's `LICENSE` and `LICENSE-EXCEPTIONS.md`), plus commercial licensing.
