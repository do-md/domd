# @do-md/core-react

![npm](https://img.shields.io/npm/v/@do-md/core-react) ![license](https://img.shields.io/badge/license-GPL--3.0%20%2B%20exceptions-blue)

A from-scratch Markdown WYSIWYG editor kernel for React.

The Markdown document itself is the editing source of truth — there is no separate
internal model to keep in sync. The kernel handles parsing, rendering, editing,
undo/redo, and streaming injection directly against the text. It is platform-agnostic:
the host application supplies platform capabilities (image resolution, syntax
highlighting) through injection points — and can extend the inline syntax itself
declaratively, from a `[[wikilink]]` to a fully custom React-rendered
`<{.mention id=11}Name>`, without touching the parse pipeline (see
["Custom inline syntax"](#custom-inline-syntax-inlinerules)).

## Install

```bash
npm i @do-md/core-react
```

Peer dependencies (you provide these):

- `react` `>=18` — required
- `react-dom` `>=18` — required
- `immer` `^10 || ^11` — required; the store is Immer-based and shares your app's Immer instance

## Quick start

Wrap the editor surface in a `DOMDProvider` and render `<DOMD />` inside it. Import the
stylesheet once.

```tsx
import { DOMDProvider, DOMD } from "@do-md/core-react";
import "@do-md/core-react/style.css";

export function MyEditor() {
  return (
    <DOMDProvider initMd={"# Title\n\nStart writing…"}>
      <DOMD />
    </DOMDProvider>
  );
}
```

Render read-only by passing `editable={false}` — the caret is suppressed and links
navigate on click.

## Reading and writing Markdown

Use `useEditorStoreApi()` for imperative one-off reads/writes:

```tsx
import { useEditorStoreApi } from "@do-md/core-react";

function ExportButton() {
  const store = useEditorStoreApi();
  return (
    <button onClick={() => console.log(store?.toMarkdown())}>Export Markdown</button>
  );
}
```

Use `useEditorStore(selector)` for reactive reads — the component re-renders only when
the selected slice changes:

```tsx
import { useEditorStore } from "@do-md/core-react";

function CursorReadout() {
  const cursor = useEditorStore((s) => s.startCursorInfo);
  return <span>{cursor ? `block ${cursor.uuid} @ ${cursor.offset}` : "no cursor"}</span>;
}
```

## Streaming injection

Feed model output into the document chunk by chunk. Partial constructs — open code
fences, half-built tables, unfinished lists — render correctly as they arrive.

```tsx
import { useEditor } from "@do-md/core-react";

function useStreamIntoEditor() {
  const editor = useEditor();
  return async (stream: AsyncIterable<string>) => {
    for await (const chunk of stream) {
      editor?.aiInsertInCursor(chunk);
    }
  };
}
```

## Batch replace (`replaceRanges` / `replaceText`)

Kernel-level batch editing for two workflows: **AI edits** (the search/replace
shape LLMs naturally produce) and **external diff reconciliation** (the file
changed on disk; diff it against `toMarkdown()` and feed the hunks back in —
without `resetMD`'s scorched-earth cost).

```tsx
const store = useEditorStoreApi();

// AI flavor: exact-text search. Duplicate matches fail with "ambiguous"
// unless disambiguated by `occurrence` (0-based).
store.replaceText(
  { search: "teh quick fox", replace: "the quick fox" },
  { search: "TODO", replace: "DONE", occurrence: 1 },
);

// Diff flavor: absolute ranges into the current toMarkdown() output.
// All offsets resolve against one pristine snapshot BEFORE anything runs —
// earlier replacements never shift later positions.
const result = store.replaceRanges(
  { start: 120, end: 135, text: "replacement" },
  { start: 400, end: 400, text: "\n\nInserted paragraph." }, // pure insertion
  { start: 512, end: 540, text: "" },                        // pure deletion
);
result.results.forEach((r) => r.applied || console.warn(r.index, r.reason));
```

Why this beats `resetMD` for reconciliation: every edit runs through the same
scoped-reparse pipeline as a user edit, so untouched blocks and spans keep
their identity. Collaborative peers receive ordinary fine-grained ops — never
a delete-all/insert-all — so concurrent edits elsewhere merge cleanly and
authorship survives. The whole batch is a single undo step.

Semantics worth knowing:

- Offsets index the **current** serialized markdown (LF). Diffing against an
  external file? Normalize CRLF and diff against the canonicalized text
  (`toMarkdown(parseMarkdown(externalMd))`-equivalent) — the editor
  re-serializes canonically, e.g. tables re-pad their columns.
- Best-effort failure policy: malformed / out-of-bounds / overlapping ranges
  and unmatched / ambiguous searches fail **individually** with a reason
  (`ReplaceEditResult`); the rest still apply. Zero applicable edits → no-op.
- Ranges may cut through markdown syntax (list markers, fences, an image's
  URL) — the result is whatever the spliced text means, exactly as if the
  edit had been made to the raw file.

## Headless usage (`EditorStore`)

The store behind `DOMDProvider` is a public export and constructs in bare
Node (>= 18) — no DOM, no React, no JSDOM. That makes it the kernel for agent
hosts, server-side sync peers, and tests: an agent edits its own store on the
server, and the resulting op stream applies onto the user's store in the
browser with authorship, undo and cursors intact.

```ts
import { EditorStore } from "@do-md/core-react";

// Server side: seed a store from the client's snapshot (uuid space is shared,
// so ops produced here land precisely on the client's tree).
const agentStore = new EditorStore({ editable: true, initMd: "" });
agentStore.applyExternalRenderData(clientSnapshot);

const ops = [];
const unsubscribe = agentStore.subscribeRenderDataOps((batch) => ops.push(...batch));
agentStore.replaceText({ search: "draft", replace: "final" });
unsubscribe();
// …ship `ops` to the client → clientStore.applyExternalRenderDataOps(ops)
```

The supported headless surface (locked by a bare-node smoke test in CI):
construction with all injection points, the document primitives (`toMarkdown`,
`resetMD`, `insertText`, `replaceText`, `replaceRanges`, `getTitle`), the sync
seam (`subscribeRenderDataOps`, `getRenderDataSnapshot`,
`applyExternalRenderData`, `applyExternalRenderDataOps`, `flushPendingInput`,
`getCursorSnapshot`, `subscribeCursorChange`) and the serialization helpers
(`serializeRenderData`, `deserializeRenderData`, `diffRenderData`).

Two things to know:

- **Large documents:** a `initMd` beyond 500 lines finishes loading
  *asynchronously* (chunked append) with no completion signal. For a
  synchronous full load, construct with `initMd: ""` and call
  `resetMD(fullText)`. `resetMD` and `applyExternalRenderData` cancel any
  pending chunked load — each establishes a new document baseline.
- **DOM-flavoured members degrade, they don't throw:** `getSelectionState`
  returns its no-selection shape until a cursor exists; edits place a model
  caret exactly like typing does.

## Injection points

The core ships no platform assumptions. Wire host capabilities through provider props:

```tsx
<DOMDProvider
  imageLoader={async (src) => toDisplayableUrl(src)} // resolve an app-specific ref to a URL the browser can render
  codeTokenizer={(code, lang) => highlight(code, lang)} // supply your own syntax-highlight tokens for code blocks
>
  <DOMD />
</DOMDProvider>
```

## Custom inline syntax (`inlineRules`)

The kernel hardcodes only standard-Markdown inline syntax. Everything beyond it —
including the built-in `==highlight==` — is a declarative rule. Register your own
delimiters through the `inlineRules` prop; rules run inside the editor's single parse
pipeline on every keystroke, so Markdown round-trip, undo, cursor behavior and
collaboration all work with no extra wiring.

```tsx
import { DOMDProvider, defaultInlineRules } from "@do-md/core-react";

<DOMDProvider
  inlineRules={[
    ...defaultInlineRules, // keep ==highlight== (omit to replace it)
    // ^superscript^
    { open: "^", close: "^", exactLen: true, allowSpace: false, tagName: "sup" },
    // ~subscript~  (~~strikethrough~~ still works)
    { open: "~", close: "~", exactLen: true, allowSpace: false, tagName: "sub" },
    // [[wikilink]]  (`[links](…)` are unaffected)
    { open: "[[", close: "]]", tagName: "span", className: "wikilink" },
  ]}
>
  <DOMD />
</DOMDProvider>
```

A rule is `open` + `close` (they may differ — asymmetric delimiters work), plus how
the span renders. Delimiters are punctuation strings; `` ` `` `\` `{` `}` can never
be part of one.

Passing `inlineRules` **replaces** the default set — spread `defaultInlineRules` to
keep `==`. Rules are compiled once at mount (remount the provider to change them),
and collaborative peers must be configured with the same set (same contract as
`codeTokenizer`).

### `{…}` parameters

Every rule accepts an optional Pandoc/Djot-style parameter block right after the
opening delimiter: `{.variant .class #id key=value key2="quoted value"}`. Params
drive rendering through declarative **`attrs` templates** (`{key}` = named param,
`{}` = first positional):

```tsx
// %%{bg=red}text%% → translucent red highlight, no pre-provisioned CSS needed
{
  open: "%%", close: "%%", tagName: "mark",
  attrs: { style: "background-color: color-mix(in srgb, {bg} 80%, transparent)" },
}
```

- Attr targets are whitelisted: `class`, `style`, `href`, `title`, `id`, `data-*`,
  `aria-*`. Event handlers (`on*`) are unreachable, `javascript:` hrefs are blocked,
  and style text compiles into a structured style object.
- An attr referencing a missing param is voided entirely — never rendered
  half-substituted.
- Every `.word` lands as a class, so `%%{.warn}text%%` is stylable from plain CSS.
- The raw `{…}` text stays verbatim in the document — params affect presentation
  only and can never corrupt the Markdown.

### Variants — one delimiter, many meanings

The first `.word` selects a **variant**: the same `==` syntax can highlight by
default and become a comment, a mention, anything — per occurrence:

```tsx
{
  open: "==", close: "==", tagName: "mark",
  variants: {
    comment: { tagName: "q", className: "comment" },
  },
}
// ==plain highlight==            → <mark>
// =={.comment author=w}text==    → <q class="comment …">
```

Unregistered variants degrade gracefully: the `.word` is just a class, and other
Pandoc-family tools still recognize the attribute syntax.

### Custom render components

For rendering that CSS can't express (icons, click handlers, tooltips), a rule or
variant may declare a React `component` — antd-style, replacing the kernel element.
Components bind to **variants** (semantics), and variants are plain data you can
attach to any delimiter — syntax and semantics stay orthogonal:

```tsx
import { viewOnlyProps, type InlineRuleComponentProps } from "@do-md/core-react";

function MentionSpan({ domProps, children, params }: InlineRuleComponentProps) {
  return (
    <span {...domProps} onClick={() => openProfile(params.named.id)}>
      <span {...viewOnlyProps} className="badge">@</span>
      {children}
    </span>
  );
}

const mention = { tagName: "span", className: "mention", component: MentionSpan };

// The same semantic on two syntaxes:
inlineRules={[
  { open: "==", close: "==", tagName: "mark", variants: { mention } },
  { open: "<",  close: ">",  tagName: "span", variants: { mention } },
]}
// =={.mention id=11}Jintao Wang== ≡ <{.mention id=11}Jintao Wang>
```

Components receive the full occurrence context: `params` (named / positional /
classes / id), `variant`, `rawCapture`, `contentText` and the dispatched `tagName`.
Overlays (popovers, tooltips) should render through a portal to `document.body` so
they never enter the editable DOM.

Hard contract (violations break cursor mapping): spread `domProps` on your root
element, render `children` verbatim, and spread `viewOnlyProps` on every
decoration element you add (badges, icons — anything that is not document
text). The marker keeps decorations out of the DOM→model text pipeline;
without it a text-bearing badge would be read back as typed input and
duplicate on every reparse. A throwing component falls back to the kernel's
default rendering — the document is never at risk.

### Reserved delimiters

Structural Markdown delimiters (`<`, `>`, `[`, `*`, `~~`) can be registered too.
Such rules only fire on shapes the builtin never produces, so existing documents
keep parsing:

- **`{…}` disambiguation** — `<{.mention id=1}Name>` fires your `<`/`>` rule;
  `<https://x.com>` and `<u>…</u>` still parse as before.
- **Longest-prefix precedence** — `[[wikilink]]` beats the builtin `[` link parse;
  `[link](url)` is untouched.

Precedence is always: your rule → builtin syntax → literal text.

### Credits

This API grew out of [do-md/domd#13](https://github.com/do-md/domd/issues/13). Thanks
to [Paul Hammant](https://github.com/paul-hammant) for the concrete, well-argued
feature request — it pushed on exactly the right boundary and made the extension
surface better than what either side first proposed. The example syntaxes follow
[kotaindah55/extended-markdown-syntax](https://github.com/kotaindah55/extended-markdown-syntax).

## Replacing default elements (`renderComponent`)

Every kernel element — image, link, table, code block… — can be replaced by a host
component. One generic mechanism: the map is keyed by `MarkdownType`, and a
replacement has the **same single-prop signature as every kernel element**:
`({ parsedData }: RenderElementProps) => JSX`. Your component is a peer of the
built-in ones, built from the same public kit:

- **`<RenderChildren parsedData={d} />`** — the node's kernel-rendered editable
  content. Render it exactly **once**, at the position where the document text
  lives (skip it only for atomic embeds like images, which have no editable
  children).
- **`getRenderElementProps(d)`** / **`getSpanRenderIdProps(d)`** — spread both
  onto your **root** element, in this order. They carry the render-id and
  styling the cursor DOM↔model mapping depends on.
- **`serializeRenderData(d).props`** — read node data (`src`, `href`, …) via
  stable keys. The internal tree is obfuscated; never rely on raw fields.
- **`toMarkdown(d)`** — the node's Markdown source.
- **`viewOnlyProps`** — spread on every decoration element you add (badges,
  toolbars — anything that is not document text).

```tsx
import {
  DOMDProvider, DOMD, MarkdownType, RenderChildren,
  getRenderElementProps, getSpanRenderIdProps, serializeRenderData,
} from "@do-md/core-react";

function FancyLink({ parsedData }) {
  const { href } = serializeRenderData(parsedData).props;
  return (
    <a
      {...getRenderElementProps(parsedData)}
      {...getSpanRenderIdProps(parsedData)}
      onClick={(e) => { e.preventDefault(); if (e.metaKey) window.open(href); }}
    >
      <RenderChildren parsedData={parsedData} />
    </a>
  );
}

const overrides = { [MarkdownType.Link]: FancyLink }; // define OUTSIDE render

<DOMDProvider initMd={md} renderComponent={overrides}>
  <DOMD />
</DOMDProvider>
```

The officially supported override targets are the `MarkdownType` members declared
in the typings — `Img`, `ImgGroup`, `Link`, `Table`, `Pre` (code block) — and the
set grows over time. Overrides are view-layer only: parsing, round-trip and sync never see
them, and a component that throws during render falls back to the kernel's
default element. Same hard contract as inline-rule components: root props from
the two helpers, `RenderChildren` rendered verbatim, `viewOnlyProps` on every
decoration. Overlays (previews, popovers) should render through a portal to
`document.body` so they never enter the editable DOM.

## Image groups (`imgGroupSeparators`)

Opt-in: when the `imgGroupSeparators` prop is set, **two or more adjacent images
in one paragraph flow** are wrapped into a single `MarkdownType.ImgGroup` node at
parse time. Default rendering is unchanged (a layout-neutral inline span around
the same children) — the point is to give `renderComponent[MarkdownType.ImgGroup]`
one node to replace, e.g. with a swipeable gallery.

The prop value is the **set of characters allowed between two grouped images**
(not an exact string):

- `""` — only images that touch (`![a](1.png)![b](2.png)`) group.
- `" "` — any run of spaces between images groups.
- `", "` — commas and/or spaces group (`![a](1.png), ![b](2.png)`).

What never groups, by design:

- **Soft line breaks.** `\n` is never a valid separator, even if included in the
  prop value — images on adjacent lines of one paragraph stay ungrouped.
- **Separate paragraphs.** Images split by a blank line are different blocks;
  cross-block grouping is not supported.

Grouping is aggregation, not rewriting. The group's children are the original
nodes verbatim — the image wrappers **plus the separator text between them** —
so round-trip stays byte-exact and nothing is dropped or normalized. The group
spans from the first image to the last: surrounding text (including leading /
trailing spaces) stays outside. A single image is never wrapped. Choosing a
non-whitespace separator (e.g. `","`) is a dialect commitment for your
documents: commas between images are treated as separators, not prose — the
default renderer still shows them; a gallery override typically hides them.

```tsx
import {
  DOMDProvider, DOMD, MarkdownType,
  getRenderElementProps, getSpanRenderIdProps, serializeRenderData, RenderChildren,
} from "@do-md/core-react";

function Gallery({ parsedData }) {
  // Collect descendant images via stable keys.
  const images = [];
  const walk = (n) => {
    if (n.type === "Img") images.push({ src: n.props.src, alt: n.props.alt });
    (n.children || []).forEach(walk);
  };
  walk(serializeRenderData(parsedData));
  return (
    <span {...getRenderElementProps(parsedData)} {...getSpanRenderIdProps(parsedData)}>
      {/* Document text (hidden syntax + separators) must stay in the DOM: */}
      <span style={{ display: "none" }}>
        <RenderChildren parsedData={parsedData} />
      </span>
      <MySwiper images={images} /> {/* decoration — spread viewOnlyProps inside */}
    </span>
  );
}

const overrides = { [MarkdownType.ImgGroup]: Gallery };

<DOMDProvider initMd={md} imgGroupSeparators=" " renderComponent={overrides}>
  <DOMD />
</DOMDProvider>
```

`imgGroupSeparators` is construction-time only (remount the provider to change
it), and collaborative peers must share the same value — same contract as
`inlineRules`.

## Embed / submit-on-Enter mode

For chat-style inputs, rebind the "real newline" key so a bare Enter yields to the host
and fires `onEnter`:

```tsx
<DOMDProvider
  newlineKey="Shift+Enter" // Shift+Enter inserts a newline; bare Enter is freed
  onEnter={(store) => submit(store.toMarkdown())}
>
  <DOMD />
</DOMDProvider>
```

## API reference

### Components

- **`DOMDProvider`** — context provider; configures the editor and hosts the surface.
- **`DOMD`** — the editor surface. Render inside a `DOMDProvider`.

### `EditorStore` (headless)

- **`EditorStore`** `new (props: StoreConstructorProps) => EditorStoreApi` — the
  store class behind `DOMDProvider`, constructible directly in bare Node (see
  ["Headless usage"](#headless-usage-editorstore)).
- **`StoreConstructorProps`** — the constructor's prop bag: `editable`
  (required) plus the same optional fields as `DOMDProvider` minus
  `children`/`renderComponent` (`initMd`, `placeholder`, `imageLoader`,
  `codeTokenizer`, `codeBeautify`, `htmlTokenizer`, `inlineRules`,
  `newlineKey`, `onEnter`).

### `DOMDProvider` props

- **`children`** `ReactNode` — editor surface; render `<DOMD />` here.
- **`initMd`** `string` — initial Markdown document.
- **`editable`** `boolean` — when `false`, renders read-only (no caret; links navigate).
- **`placeholder`** `string` — shown when the document is empty.
- **`imageLoader`** `(src: string) => Promise<string>` — resolve an image reference to a
  displayable URL.
- **`codeTokenizer`** `(code: string, lang?: string) => unknown[]` — provide
  syntax-highlight tokens for code blocks.
- **`codeBeautify`** `(code: string, lang?: string) => string | undefined` — optional
  code formatter, invoked on Enter inside a code block; return `undefined` to skip.
- **`inlineRules`** `InlineRule[]` — declarative custom inline syntax (see
  ["Custom inline syntax"](#custom-inline-syntax-inlinerules)); replaces the default
  set (`defaultInlineRules`).
- **`imgGroupSeparators`** `string` — opt-in image grouping: the set of characters
  allowed between grouped images (`""` = touching only; `" "` = spaces; `", "` =
  commas/spaces). `\n` never qualifies. See
  ["Image groups"](#image-groups-imggroupseparators).
- **`renderComponent`** `Partial<Record<MarkdownType, ComponentType<RenderElementProps>>>`
  — replace kernel default elements (see
  ["Replacing default elements"](#replacing-default-elements-rendercomponent)).
- **`newlineKey`** `"Shift+Enter"` or `"Mod+Enter"` — rebind the newline key so bare
  Enter fires `onEnter`.
- **`onEnter`** `(store: EditorStoreApi, event: KeyboardEvent) => void` — called on bare
  Enter when `newlineKey` is set.

### Hooks

- **`useEditor()`** → `EditorController` or `null` — imperative handle: `focus()`,
  `aiInsertInCursor(text)`, `editorStore`.
- **`useEditorStore(selector)`** → `T` — reactive selector; re-renders when the selected
  slice changes.
- **`useEditorStoreApi()`** → `EditorStoreApi` or `null` — imperative store handle for
  one-off reads/writes.
- **`useRenderData()`** → `RenderData` — current parsed-document handle (opaque).
- **`useEditorDom()`** → `{ textAreaDomRef }` — ref to the editable DOM node.

### `EditorStoreApi` (selected members)

- **`toMarkdown()`** `string` — serialize the document to Markdown.
- **`resetMD(md)`** `void` — replace the whole document.
- **`insertText(text)`** `void` — insert text at the cursor.
- **`insertImage(url, altText?)`** `void` — insert an image at the cursor.
- **`getTitle()`** `string` — plain-text title derived from the first block.
- **`getSelectionState(contextChars?)`** `SelectionState` — selection / cursor snapshot.
- **`getSelectionOffsets()`** `{ start, end } | null` — absolute offsets of the
  current caret/selection into `toMarkdown()` output: the read-only dual of
  `setSelection`'s range form, exact everywhere tables included. `null` before a
  cursor is placed. The addressing primitive block-level commands (heading /
  list / quote toggles) are built on.
- **`setEditable(editable)`** `void` — toggle read-only; view state only.
- **`undo()` / `redo()`** `void` — step the model edit history.
- **`replaceRanges(...edits: RangeEdit[])`** `ReplaceResult` — batch replace by
  absolute offsets into the current `toMarkdown()` output; identity-preserving,
  one undo step, per-edit success reporting.
- **`replaceText(...edits: TextEdit[])`** `ReplaceResult` — batch replace by exact
  text match (`occurrence` disambiguates duplicates); same pipeline as
  `replaceRanges`.
- **`addTableRow(tableUuid, rowIndex?)`** `boolean` — insert an empty row
  (`rowIndex` 0-based among body rows; omitted → append). Pass the table's uuid
  or any uuid inside it. Caret lands in the new row's first cell; one undo step.
- **`addTableColumn(tableUuid, colIndex?)`** `boolean` — insert an empty column
  (omitted index → append right). Caret lands in the new column's header cell.
- **`deleteTableRow(tableUuid, rowIndex?)`** `boolean` — delete a body row
  (omitted index → inferred from the uuid: pass the caret/cell uuid to delete
  the row containing it). Caret moves to the row that takes the slot.
- **`deleteTableColumn(tableUuid, colIndex?)`** `boolean` — delete a column
  (omitted index → inferred from the uuid). The last remaining column cannot be
  deleted. Caret moves to the header cell that takes the slot.
- **`startCursorInfo`** `CursorInfo` or `null` — reactive cursor position.
- **`isEditable`** `boolean` — reactive editable flag.
- **`duringComposition`** `boolean` — reactive IME-composition flag.
- **`subscribe(listener)`** `() => void` — subscribe to any store change; returns an
  unsubscribe fn.

### Utilities

- **`toMarkdown(data: RenderData)`** → `string` (or `null`) — serialize a `RenderData`
  handle (from `useRenderData()`) to Markdown.
- **`defaultInlineRules`** `InlineRule[]` — the shipped rule set (`==` highlight);
  spread it to compose.
- **`viewOnlyProps`** — prop bag for decoration elements inside inline-rule
  `component` renders and `renderComponent` overrides (marks the subtree
  invisible to the text pipeline + `contentEditable={false}` + `aria-hidden`).
- **`Renderer`** `FC<RenderElementProps>` — render any node the kernel way
  (dispatches through `renderComponent` overrides and default elements).
- **`RenderChildren`** `FC<RenderElementProps>` — a node's kernel-rendered editable
  content; the building block for `renderComponent` overrides.
- **`getRenderElementProps(parsedData)`** / **`getSpanRenderIdProps(parsedData)`**
  — kernel element root-prop builders; spread both on an override's root element.
- **`MarkdownType`** — kernel element identity enum (the `renderComponent` key);
  typings declare the officially replaceable members.
- **`DATA_VIEW_ONLY`** `string` — the underlying decoration-marker attribute name,
  for non-JSX consumers.
- **`RenderElementProps`** — the single-prop signature shared by every kernel
  element and every `renderComponent` override: `{ parsedData: AnyRenderData }`.
  Type your overrides with it instead of spelling the node union yourself.
- **`AnyRenderData`** — any node, leaf (`RenderData`) or branch
  (`ParentRenderData`). Opaque: hand it back to the kernel helpers rather than
  branching on its shape.
- Types: **`InlineRule`**, **`InlineRuleVariant`**, **`InlineRuleParams`**,
  **`InlineRuleComponentProps`**, **`RangeEdit`**, **`TextEdit`**,
  **`ReplaceResult`**, **`ReplaceEditResult`**, **`ReplaceFailureReason`**,
  **`StoreConstructorProps`**, **`EditorStoreApi`**, **`CursorInfo`**.

## License

[GPL-3.0](./LICENSE), with two [additional permissions](./LICENSE-EXCEPTIONS.md)
granted under GPL section 7:

1. **Small entity exception** — non-profits and educational institutions, plus
   individuals and companies under USD 1M annual revenue and under USD 2M
   raised, may link this kernel into non-GPL software and ship it under terms
   of their choice.
2. **FOSS license exception** — projects under MIT, Apache-2.0, BSD, MPL-2.0,
   ISC, EPL-2.0 or zlib may link this kernel and ship the combined work under
   their own license.

Both permissions require that the kernel itself stays under the GPL and that
its source stays available to your users. They are irrevocable for every
released version that carries them.

> Free to try, free to build with, free to ship if you are small or open
> source. A commercial license is needed once you ship a proprietary product
> and pass the size threshold.

GPL obligations attach when you **convey** — and because this kernel runs in a
browser, shipping a web app that loads it is conveying, not internal use.
Development, testing and internal evaluation on machines you control carry no
obligations. For proprietary use beyond the exceptions above, a commercial
license is available — contact <effyouapp@gmail.com>; see
[LICENSE-EXCEPTIONS.md](./LICENSE-EXCEPTIONS.md).

Versions up to and including 0.10.0 were published under the PolyForm
Noncommercial 1.0.0 license. From 0.11.0 on, the kernel is GPL-3.0 with the
additional permissions above, and its source lives in the public repository.

Source: <https://github.com/do-md/domd> (see `.packages/@do-md/core`).
