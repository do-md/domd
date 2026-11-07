# Changelog

<sub>English · [简体中文](./CHANGELOG.zh-CN.md) · [日本語](./CHANGELOG.ja.md)</sub>

All notable changes to DOMD are documented in this file, newest first. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

- **Versions.** Each section is a DOMD app release — the macOS app and the web editor at [domd.app](https://www.domd.app) — matching the `vX.Y.Z` git tags and [GitHub Releases](https://github.com/do-md/domd/releases). The web editor is deployed from `main`, so web changes can go live before the release that lists them.
- **Editor kernel.** [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) has its own npm version line. Each section names the kernel version it ships. *(kernel)* marks changes made in the kernel; **Kernel API** entries are for developers who embed it. Since v0.6.0 the kernel source lives in this repository and the app builds it from source.
- **Scope.** Internal work — refactors, build and CI fixes, test harnesses, benchmarks, dependency syncs — is left out. Contributions from the community are credited inline.

## [Unreleased]

Kernel: `@do-md/core-react` 0.13.1 and 0.14.0 are published on npm; entries marked *(kernel, unpublished)* ship in the next kernel release.

### Added

- Line breaks in table cells: Enter or Shift+Enter inside a cell inserts a line break, stored as `<br>` in the Markdown. Typed or pasted multi-line text in a cell is written the same way, and `<br/>`, `<BR>` and `<br />` are normalized to `<br>` on save. Cells stay inline-only: `- x`, `# x` or a blank line inside a cell never become a list, heading or new paragraph. *(kernel, unpublished)*
- **Kernel API:** an inline `<br>` renders as a `MarkdownType.HardBreak` node, so a `renderComponent` override can target it; its `<br>` element carries `data-domd-hard-break`. `MarkdownType.Br` remains only the placeholder of an empty block. *(kernel, unpublished)*
- **Kernel API:** `filePaths` option (off by default) recognizes local file paths in text — `/tmp/a.png`, `~/notes/x.md`, `src/foo.ts:12:3` — and wraps each in a `FilePath` node that hosts can render as they like; `getFilePathInfo()` returns the path, line and column. The source text is unchanged. *(kernel 0.14.0)*
- **Kernel API:** `copyAs` option on `DOMDProvider`: `"markdown"` (default, unchanged) or `"text"` — what a reader sees, without syntax symbols or link URLs, with tables as tab-separated rows ([#46](https://github.com/do-md/domd/issues/46)). *(kernel 0.14.0)*

### Changed

- Copy and cut write to the clipboard synchronously from the copy event instead of through the async Clipboard API, so they need no permission and work inside iframes. *(kernel 0.14.0)*
- With `copyAs: "text"`, a `<br>` line break is copied as a line break, and copying a whole table quotes the cells that span several lines, so a spreadsheet still gets one row per row. *(kernel, unpublished)*

### Fixed

- Inline `<br>` (also `<br/>`, `<br />`, any case) renders as a line break instead of showing the tag as text — common in AI answers inside table cells ([#47](https://github.com/do-md/domd/pull/47) — thanks [@123soulshell](https://github.com/123soulshell)). *(kernel, unpublished)*
- Right after a `<br>` line break, the caret is drawn at the start of the next line, and typed or IME text lands after the break instead of before it. *(kernel, unpublished)*
- Clicking formatted text in a read-only view no longer reveals its Markdown symbols, such as the `**` around bold text. *(kernel 0.13.1)*
- A bare URL inside link text no longer produces a link nested inside a link. *(kernel 0.14.0)*
- Copying a selection that starts inside an inline badge (such as a mention) no longer shifts the copied text, and a copy that cannot be mapped to the document falls back to the browser's own copy instead of an empty clipboard. *(kernel 0.14.0)*

## [0.10.0] - 2026-09-23

Kernel: `@do-md/core-react` 0.13.0.

### Added

- Large documents stay fast: once a document has 500 or more top-level blocks, the editor, the collaboration page and the preview render only the blocks near the viewport. A 10 MB document now opens in about 2.6 s instead of crashing the renderer. On the web, `?virtual=off|auto|always` in the URL overrides the behavior.
- Printing and PDF export of such documents render every block first, so nothing is cut off.
- **Kernel API:** a render-window seam, `getTopLevelBlocks()` / `getTopLevelBlockCount()` / `getTopLevelUuid()`, and a chunked-loading signal (`isLoadingChunks` / `subscribeLoadingChange`). The windowing engine ships as the new `@do-md/virtual` package.

### Fixed

- Opening a large file could save a partially loaded copy over it (a 2 MB file was cut to 144 KB). While a file is still loading, editing is now locked, and autosave, drafts, collaboration and PDF export wait until it is complete.
- Opening a file no longer rewrites it with normalized Markdown.
- Text typed while a save was in progress could be left unsaved; it is now included in the next save.
- Parsing is linear again: a 10 MB document parses in about 2 s instead of 50 s, and 2 MB of list content in 0.6 s instead of 10 s. *(kernel)*
- Documents with around 190,000 blocks can join a collaboration session instead of failing with a stack overflow.
- With the outline open, scrolling a document with thousands of headings no longer stutters (108 ms → 0.2 ms per frame with 3,271 headings).
- Editing a selection that spans two table cells no longer deletes the cell separator and merges the cells; the edit stays inside the cell where it starts ([#44](https://github.com/do-md/domd/pull/44) — thanks [@Systemofdumb](https://github.com/Systemofdumb)). *(kernel)*
- Read-only views ignore editing gestures again: ⌘Z, ⌘B and similar shortcuts do nothing, text can be dragged out, and clicking below a trailing code block no longer adds a paragraph. Switching between read-only and editable is no longer recorded in the undo history. *(kernel)*
- Typing in a code block next to an identical character (for example `)` before `)`) no longer doubles the character. *(kernel)*

## [0.9.2] - 2026-09-16

Kernel: `@do-md/core-react` 0.12.3.

### Fixed

- ⌘A selects the whole document even when it starts or ends with a table, or contains only a table ([#43](https://github.com/do-md/domd/issues/43)). *(kernel)*
- Triple-click selects one line inside one block instead of spilling into the neighboring blocks ([#42](https://github.com/do-md/domd/issues/42)). *(kernel)*

## [0.9.1] - 2026-09-13

Kernel: `@do-md/core-react` 0.12.2.

### Added

- AI agents can use any OpenAI-compatible endpoint — DeepSeek, Moonshot, a local server, a reverse proxy. Paste a bare host, a base URL ending in a version such as `/v1`, or a full chat-completions URL. Several agents can share one endpoint and its API key; deleting the last agent that uses a custom endpoint removes the endpoint and its key ([#28](https://github.com/do-md/domd/issues/28)).

### Fixed

- With an input method active (for example Chinese input) in the desktop app, typing `@` no longer closes the agent picker the moment it opens.
- Confirming an input-method candidate with Enter no longer sends a half-typed instruction to the agent.

## [0.9.0] - 2026-09-13

Kernel: `@do-md/core-react` 0.12.1, 0.12.2.

### Added

- Tabs in the desktop app: one window can hold several documents ([#29](https://github.com/do-md/domd/issues/29), [#38](https://github.com/do-md/domd/pull/38) — thanks [@Systemofdumb](https://github.com/Systemofdumb); follow-up fixes in [#40](https://github.com/do-md/domd/pull/40)).
  - ⌘N opens a new tab, ⇧⌘N a new window; ⇧⌘[ and ⇧⌘] switch tabs; drag tabs to reorder them. A window with a single document shows no tab bar.
  - Each tab keeps its own undo history, selection and scroll position across switches.
  - Opening a file from Finder or dropping it on a window activates the tab that already has it, reuses an empty tab, or opens a new one.
  - Closing a tab with unsaved changes asks Save / Don't Save / Cancel. Closing the window or quitting asks about every unsaved untitled tab, and pending edits to saved files are written first.
  - A background tab picks up changes other programs made to its file when you switch back to it.
- Find & replace and the outline panel on the collaboration page; read-only viewers get the outline too.
- **Kernel API:** `DOMDProvider` accepts an existing `store` (bring your own `EditorStore`). The kernel keeps each store's scroll position, selection and focus and restores them when a view re-attaches.

### Changed

- ⌘W closes the current tab when the window has more than one; Close Window moves to ⇧⌘W.

### Fixed

- Letter shortcuts follow the letter on the key, not its position: on AZERTY, ⌘W no longer runs Undo, and QWERTZ, Dvorak and other layouts behave the same way ([#36](https://github.com/do-md/domd/pull/36) — thanks [@Systemofdumb](https://github.com/Systemofdumb)). *(kernel)*
- Undo, Redo and Select All in the Edit menu (and ⌘Z / ⇧⌘Z / ⌘A) reach the editor instead of the webview's built-in editing commands, and use Ctrl outside macOS ([#37](https://github.com/do-md/domd/pull/37) — thanks [@Systemofdumb](https://github.com/Systemofdumb)).
- The macOS menu bar is rebuilt only when the language actually changes. Rebuilding it on every launch could deliver a shortcut such as ⌘W to a menu item that was no longer on screen ([#35](https://github.com/do-md/domd/pull/35) — thanks [@Systemofdumb](https://github.com/Systemofdumb)).
- ⌘A in the desktop app no longer flashes the selection and then loses it, and the macOS text-navigation keys Ctrl+A/E/N/P/F/B work again instead of being treated as ⌘ shortcuts ([#27](https://github.com/do-md/domd/issues/27), [#39](https://github.com/do-md/domd/pull/39)). *(kernel)*
- Pressing Backspace in an empty document in the desktop app no longer leaves the editor unable to take input ([#33](https://github.com/do-md/domd/issues/33)). *(kernel)*
- Clicking an empty area after a document has loaded no longer scrolls back to the top. *(kernel)*

## [0.8.1] - 2026-08-30

Kernel: `@do-md/core-react` 0.12.0.

### Fixed

- The desktop app no longer crashes on the third click of a title-bar button (release builds only).

## [0.8.0] - 2026-08-30

Kernel: `@do-md/core-react` 0.12.0.

### Added

- Document outline: a side panel on the left that lists the document's headings ([#22](https://github.com/do-md/domd/issues/22)). Open it from the top bar, from the title-bar button in the desktop app, or with ⇧⌘O (Ctrl+Shift+O). The current heading follows your scrolling; clicking an entry jumps to the heading and puts the caret on it.
- Find & replace ([#22](https://github.com/do-md/domd/issues/22)): ⌘F / Ctrl+F to find, ⌥⌘F / Ctrl+H to replace, ⌘G / F3 or Enter / Shift+Enter to move between matches, Esc to close. Options for match case, whole word, regular expressions (with capture groups in the replacement) and preserve case. Replace All is a single undo step. Also available from the More (⋯) menu for touch devices.
- **Kernel API:** `resolveBlockOffset(uuid)` and `resolveRanges()`, read-only lookups between Markdown offsets and blocks. The outline and search engines ship as the `@do-md/toc` and `@do-md/search` packages.

## [0.7.1] - 2026-08-27

Kernel: `@do-md/core-react` 0.11.7.

### Fixed

- Clicking below a document that ends with a code block or table puts the caret on a new empty line. Before, the caret landed inside the block and the format menu stopped working. *(kernel)*

## [0.7.0] - 2026-08-27

Kernel: `@do-md/core-react` 0.11.6.

### Added

- Title-bar buttons in the desktop app: Insert (table, checklist), Rich/Markdown mode, AI, the Aa format menu and a More (⋯) menu, all with native macOS menus.
- Export PDF in the desktop app writes straight to the file you choose, without a print dialog and without page headers or footers.
- Printing from the browser (⌘P) prints the whole document, without the toolbar, collaborators' cursors or authorship colors.
- **Kernel API:** `store.blur()`, the model-side counterpart of `focus()`.

### Changed

- In the desktop app, AI settings, including API keys, are stored in `~/.domd/ai.json` instead of the webview's local storage; existing settings move there on first launch.

### Fixed

- Clicking an empty part of the desktop title bar now properly leaves the document. Before, the caret kept blinking, keys went to the wrong place and inserts were refused.

## [0.6.1] - 2026-08-27

Kernel: `@do-md/core-react` 0.11.5.

### Fixed

- Forward delete (fn+Delete, Ctrl+D, Option+fn+Delete), delete to end of line (Ctrl+K), delete to start of line (⌘Delete) and delete word (Option+Delete) are now handled by the editor. Before, they could duplicate content, break undo and eventually freeze the editor ([#21](https://github.com/do-md/domd/issues/21)). *(kernel)*

## [0.6.0] - 2026-08-26

Kernel: `@do-md/core-react` 0.11.4 (up from 0.8.1).

### Added

- AI agents as collaborators (web): type `@` anywhere in the document to call an agent at the caret and tell it what to change. Its edits are highlighted as they land and appear in the version history and authorship colors like anyone else's; this also works without a live session. Agents, models and API keys are set up in the AI panel; the `mock` model runs offline.
- Aa format menu in the top bar, in the style of Apple Notes: bold, italic, underline, strikethrough, highlight; title, heading, subheading, body; bulleted, numbered and checklists; block quote; divider; clear formatting.
- Shortcuts for the format menu: ⇧⌘X strikethrough, ⇧⌘H highlight, ⌘4–⌘6 headings, ⇧⌘L checklist, ⇧⌘9 block quote, ⌘\ clear formatting (Ctrl instead of ⌘ on Windows and Linux). ⌘0–⌘6 and ⌘T reach the document only in the desktop app, because browsers keep those keys for their own tabs.
- Welcome tour (web): a first visit with an empty editor opens a short tour in your language; existing drafts and sessions are left untouched.
- The collaboration page gets the editor's top bar for participants who can edit: the Aa menu, the insert buttons, and a More menu with the mode switch, Download and Export PDF.
- Inline formatting from the menu can be applied inside table cells.
- **Kernel API:** a typed headless `EditorStore`, `setSelection()`, `getSelectionOffsets()`, rich mode with reactive format state, and opt-in grouping of adjacent inline images. Named editing commands move out of the kernel into the new `@do-md/commands` package.

### Changed

- The editor kernel is open source under GPL-3.0 with two additional permissions (a small-entity exception and a FOSS-combination exception), and its source now lives in this repository. npm versions up to 0.10.0 remain under PolyForm Noncommercial 1.0.0; 0.11.0 and later are GPL. The app's own code stays MIT, and commercial licenses for the kernel are available. Contributors sign a [CLA](./CLA.md).
- ⌘B / ⌘I / ⌘U go through the editor and toggle exactly like the menu. Before, the browser's built-in commands applied formatting the editor did not track, so pressing them twice did not undo it.
- The Rich/Markdown mode switch moved into the More (⋯) menu, gained ⌘/ (Ctrl+/), and is remembered between visits.
- The AI and version-history panels open as a side drawer: next to the document on wide screens, over it on small ones.
- The checklist button in the toolbar toggles a checklist on and off, the same as ⇧⌘L.

### Removed

- The kernel's built-in ⇧⌘C shortcut for inserting a code block.

### Fixed

- Empty to-do items (`- [ ] `) and empty block quotes (`> `) survive saving and reopening instead of turning into a bullet with the text `[ ]` or disappearing. *(kernel)*
- A table directly after a paragraph, with no blank line in between, is recognized as a table, as in GFM ([#19](https://github.com/do-md/domd/pull/19) — thanks [@BetterAndBetterII](https://github.com/BetterAndBetterII)). *(kernel)*
- Undo and Redo from the macOS Edit menu, trackpad gestures, the context menu or shake-to-undo use the editor's own history instead of the browser's, which was out of sync ([#20](https://github.com/do-md/domd/issues/20)). *(kernel)*
- The caret is visible in empty table cells, such as those of a newly inserted table. *(kernel)*
- The desktop app no longer re-renders its whole interface on every launch.

## [0.5.0] - 2026-08-05

Kernel: `@do-md/core-react` 0.8.1.

### Added

- Table editing: hover the right or bottom edge of a table to add a column or row; handles next to the caret open menus to insert or delete the current row or column (the header row cannot be deleted).
- Quick-insert buttons for a table and a checklist, in the top bar of the editor and the collaboration page and in the macOS title bar.
- **Kernel API:** `renderComponent` overrides for custom block renderers, built on `serializeRenderData` and `RenderChildren`.

## [0.4.1] - 2026-08-02

Kernel: `@do-md/core-react` 0.7.1.

### Added

- Shift+Enter inserts a line break inside a paragraph (saved as a single newline); Enter still starts a new paragraph. *(kernel)*

### Changed

- More generous spacing between blocks. *(kernel)*

## [0.4.0] - 2026-08-01

Kernel: `@do-md/core-react` 0.7.0 (up from 0.4.7).

### Added

- Real-time collaboration in the desktop app: share the open document and manage the session from the title bar. Documents that have never been saved can be shared too.
- Changes that other programs (Obsidian, VS Code, Typora…) make to an open file merge into the document live, with undo and collaboration intact; changes made while DOMD was closed are merged when the session resumes.
- `domd-cli` can open a file straight into the share dialog, for integrations such as the Obsidian plugin.
- Colored highlights: `=={red}text==` tints the highlight with a CSS color ([#13](https://github.com/do-md/domd/issues/13), [#15](https://github.com/do-md/domd/pull/15)).
- **Kernel API:** `inlineRules` for custom inline syntax (v2: string delimiters, Pandoc-style parameters, variants, rendering through React components) and the batch edit primitives `replaceRanges()` / `replaceText()`.

### Changed

- The desktop app gives each document a stable identity: opening a file adds a `domd-id` field to its frontmatter (written to the file if missing), so collaboration follows the document across renames and moves. The frontmatter is never shown in the editor.
- Share links created in the desktop app always point to https://www.domd.app.
- Saving content identical to what is already on disk is skipped, so other editors' change detection (such as Typora's) stays quiet.

## [0.3.6] - 2026-07-30

Kernel: `@do-md/core-react` 0.4.7. (v0.3.5 was tagged but not published; its changes are included here.)

### Added

- Collaboration panel: collaborators with online/offline status, a version timeline recorded automatically shortly after edits pause, highlighting of the text each person wrote, and restoring an earlier version (the restore becomes a new version).
- Collaborators' selections are shown, not just their cursors.

### Changed

- Joining a session transfers only the changes the newcomer is missing, instead of the whole document from every peer ([#14](https://github.com/do-md/domd/pull/14)).
- The share dialog now only manages invite links; the collaborator count moved to the collaboration panel button.
- Guests see the last synced copy of the document right away instead of a blank page while connecting.

### Fixed

- Code blocks in languages the highlighter does not support (such as `mermaid` or `jsonc`) show their code as plain text instead of rendering empty. *(kernel)*
- Selections dragged backwards (bottom to top or right to left) no longer vanish during the drag or right after releasing the mouse. *(kernel)*

## [0.3.4] - 2026-07-28

Kernel: `@do-md/core-react` 0.4.6.

### Fixed

- Text typed on the empty line after a table, code block or divider is no longer glued onto that block's last line when saved (for example `| a | b |text`). *(kernel)*

## [0.3.3] - 2026-07-28

Kernel: `@do-md/core-react` 0.4.5.

### Fixed

- A document that opens as a single empty paragraph shows the placeholder. *(kernel)*

## [0.3.2] - 2026-07-28

Kernel: `@do-md/core-react` 0.4.4.

### Added

- Export PDF from the More (⋯) menu on the web: a vector PDF of the rendered document, without syntax markers or page headers and footers, keeping code-block backgrounds and named after the document ([#12](https://github.com/do-md/domd/pull/12)).

### Changed

- Typography pass: a themeable font, font smoothing and adjusted heading weights. *(kernel)*

### Fixed

- Backspace deletes a whole emoji instead of leaving a broken character (U+FFFD). *(kernel)*
- A heading or divider followed directly by a list, table or block quote, with no blank line between them, is no longer merged onto one line when saved. *(kernel)*

## [0.3.1] - 2026-07-27

Kernel: `@do-md/core-react` 0.4.3.

### Added

- Real-time collaboration on the web: share a document through an invite link and edit it together live, peer to peer over WebRTC, with everyone's cursor and name shown. Links can have a password and an expiry time, and read-only links let others follow along without editing. Images sync too.
- Real-time sync playground (`/playground/live`): open the same document in several browser tabs and watch edits and cursors sync.
- The web editor keeps a local draft of the open document, so reloading the page restores it.
- **Kernel API:** replaying inbound operations (`applyExternalRenderDataOps`), cursor snapshots and span-level anchors for real-time sync.

### Changed

- The editor no longer takes focus automatically when it opens.
- Starting a new document asks for confirmation first; during a collaboration session it ends the session for everyone.

### Fixed

- A collaborator who leaves the editor no longer leaves a ghost cursor behind on other people's screens. *(kernel)*
- The caret position after undo is more stable. *(kernel)*
- Moving the caret out past the end of a link no longer leaves stray text next to it. *(kernel)*

## [0.3.0] - 2026-07-23

Kernel: `@do-md/core-react` 0.3.1.

### Added

- Conflict-free offline merging: a split-screen CRDT playground (`/playground/crdt`), linked from the site navigation, shows two editors working offline on the same paragraph and merging without conflicts, through a Yjs sync plugin.
- **Kernel API:** span-preserving block merge and a sync seam (operation stream in and out) for CRDT integrations.

### Fixed

- Several editors on one page no longer steal each other's caret. *(kernel)*

## [0.2.12] - 2026-07-22

Kernel: `@do-md/core-react` 0.2.15.

### Changed

- Re-indenting code on Enter also covers languages without a dedicated formatter, based on brackets; indentation-sensitive code such as Python or YAML is left as it is.
- Selection tracking was reworked to be more robust. *(kernel)*

### Fixed

- Selecting text on iOS shows the normal highlight and selection handles again; with the custom caret they were grey or invisible.
- The custom caret is placed correctly in empty paragraphs.
- Selecting everything inside a code block and deleting it no longer leaves the block uneditable. *(kernel)*

## [0.2.11] - 2026-07-15

Kernel: `@do-md/core-react` 0.2.14.

### Added

- Pressing Enter in a JavaScript, TypeScript, JSON, CSS, SCSS, Less, HTML or XML code block re-indents the code (indentation only).

## [0.2.10] - 2026-07-15

Kernel: `@do-md/core-react` 0.2.12.

### Fixed

- In Safari, the custom caret at the start of a line is no longer drawn one line too high.

## [0.2.9] - 2026-07-15

Kernel: `@do-md/core-react` 0.2.11.

### Added

- Mobile quick-input bar: a row of Markdown keys pinned above the on-screen keyboard, respecting the safe area on iPhones with a notch ([#11](https://github.com/do-md/domd/pull/11)).

### Fixed

- The custom caret is positioned correctly inside code blocks.
- Table borders use an opaque color, so the crossings no longer look darker. *(kernel)*

## [0.2.8] - 2026-07-07

Kernel: `@do-md/core-react` 0.2.10.

### Added

- The interface is available in English, Chinese and Japanese and follows the system language — in the web editor and the desktop app, including the native menus. macOS also localizes its standard menu items and dialogs ([#8](https://github.com/do-md/domd/pull/8)).
- The homepage README is read-first: it streams in as read-only text, and an "Edit" pill switches it to editing in place. Streaming speeds up once the text runs past the first screen ([#10](https://github.com/do-md/domd/pull/10)).
- **Kernel API:** `setEditable()`.

### Fixed

- The custom caret hides the native caret automatically, and only inside its own editor ([#9](https://github.com/do-md/domd/pull/9)).

## [0.2.7] - 2026-06-24

Kernel: `@do-md/core-react` 0.2.9 — the kernel is now consumed as an npm package.

### Fixed

- Quitting with ⌘Q or from the Dock asks about unsaved untitled windows instead of closing them silently.
- Launching DOMD through `domd-cli` no longer opens an extra empty window.
- The empty first line of a document can be deleted. *(kernel)*

## [0.2.6] - 2026-06-19

### Fixed

- Corrected the behavior of the Delete key. *(kernel)*
- Consecutive line breaks (`\n\n`) render correctly. *(kernel)*

## [0.2.5] - 2026-06-17

### Added

- Bare URLs in text are recognized as links. *(kernel)*
- Clicking an image selects it, so it can be deleted like text. *(kernel)*

## [0.2.4] - 2026-06-15

### Added

- Horizontal rules can be selected and deleted with the mouse. *(kernel)*

### Fixed

- Cutting at the caret no longer loses content. *(kernel)*
- Automatic updates in the desktop app could fail; fixed.

## [0.2.3] - 2026-06-09

### Added

- Streaming playground (`/playground`): streams Markdown into the editor chunk by chunk, with adjustable chunk size and delay (including instant) and file drop.
- Markdown-native input playground (`/chat`): an AI chat input built on the editor.
- A custom-drawn caret in the editor, the playgrounds and the homepage.
- Search and social-sharing metadata for the website, with a share image, sitemap and robots.txt.

### Fixed

- `gh:` URLs with an `@` inside the file name (such as `gh:owner/repo:docs/file@v1.md`) open the file instead of a blank document, while refs such as `feature/new-docs` or `v1.0.0` after `@` keep working ([#5](https://github.com/do-md/domd/pull/5) — thanks [@penniger](https://github.com/penniger)).
- Mobile polish: tapping the homepage reliably stops the README stream on iOS, and the playground's settings fit small screens.

## [0.2.2] - 2026-06-03

### Added

- A DOMD app menu with About DOMD and Check for Updates…, using native dialogs that show the DOMD icon.

### Changed

- Better rendering and editing of code blocks. *(kernel)*

### Fixed

- Checklist items are saved correctly. *(kernel)*

## [0.2.1] - 2026-06-02

### Added

- The homepage is DOMD itself: the README streams into a live editor in your language (English, Chinese or Japanese), and you can edit it once it finishes.
- Usage statistics: web page views are counted with Vercel Analytics, and the desktop app reports an `app_open` event with the platform and app version.

### Fixed

- A code-highlighting error that could keep the page from becoming interactive.

## [0.2.0] - 2026-06-01

### Added

- Automatic updates in the desktop app: new versions download silently at launch and when the window gains focus (checked at most once an hour), then a Restart banner appears in the bottom-right corner. Versions before 0.2.0 have to be updated manually once.

### Fixed

- Further fixes to Enter, Tab and Delete while editing. *(kernel)*

## [0.1.4] - 2026-05-29

**Critical fix — update from v0.1.3 or earlier.** After updating, reopen documents you saved with v0.1.3 and check that their contents are intact.

### Added

- README instructions for running the web app on Windows ([#2](https://github.com/do-md/domd/pull/2) — thanks [@OddMiss](https://github.com/OddMiss)).

### Fixed

- Enter and Delete/Backspace produced wrong edits after a change to the document data structure. *(kernel)*
- Documents could be serialized incorrectly, which affected the Markdown written to disk on save. *(kernel)*

## [0.1.3] - 2026-05-27

### Fixed

- Fixed a bug when deleting text. *(kernel)*

## [0.1.2] - 2026-05-27

### Added

- Intel (x86_64) Mac builds next to Apple Silicon. The Intel build is tested through Rosetta 2 on Apple Silicon.
- The website's download button offers both the Apple Silicon and the Intel build.

## [0.1.1] - 2026-05-26

### Changed

- Closing an untitled window with unsaved changes uses the native macOS "save changes?" sheet, including its Delete button.

## [0.1.0] - 2026-05-25

First release, Apple Silicon only.

### Added

- WYSIWYG Markdown editing on a Markdown-native kernel, with syntax highlighting for code blocks.
- Native macOS app: opens `.md` files from Finder, multiple windows, a Dock menu, autosave, and drag and drop of files and images.
- Quick Look extension: press Space in Finder to preview a Markdown file rendered by DOMD.
- `domd-cli` for agents and scripts: open windows, stream content into a document, rewrite the selection.
- Web editor: drop in a `.md` file or open one from a URL (including `gh:owner/repo`), with nothing uploaded.

[Unreleased]: https://github.com/do-md/domd/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/do-md/domd/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/do-md/domd/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/do-md/domd/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/do-md/domd/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/do-md/domd/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/do-md/domd/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/do-md/domd/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/do-md/domd/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/do-md/domd/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/do-md/domd/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/do-md/domd/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/do-md/domd/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/do-md/domd/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/do-md/domd/compare/v0.3.4...v0.3.6
[0.3.4]: https://github.com/do-md/domd/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/do-md/domd/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/do-md/domd/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/do-md/domd/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/do-md/domd/compare/v0.2.12...v0.3.0
[0.2.12]: https://github.com/do-md/domd/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/do-md/domd/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/do-md/domd/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/do-md/domd/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/do-md/domd/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/do-md/domd/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/do-md/domd/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/do-md/domd/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/do-md/domd/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/do-md/domd/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/do-md/domd/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/do-md/domd/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/do-md/domd/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/do-md/domd/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/do-md/domd/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/do-md/domd/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/do-md/domd/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/do-md/domd/releases/tag/v0.1.0
