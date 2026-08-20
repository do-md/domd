# DOMD

[![npm version](https://img.shields.io/npm/v/@do-md/core-react.svg?style=flat-square&labelColor=2f2f2f&color=4493f8)](https://www.npmjs.com/package/@do-md/core-react)
[![Core size](https://img.shields.io/badge/core%20Brotli-30%2B%20KB-5E81AC?style=flat-square&labelColor=2f2f2f)](https://www.npmjs.com/package/@do-md/core-react)

**A WYSIWYG Markdown editor powered by a 30+ KB, from-scratch, Markdown-native engine.**

Built for fast human editing, huge Markdown files, live synchronization, and streaming AI output.

* 30+ KB after Brotli compression, with only React and Immer as runtime dependencies
* Smooth editing and streaming through 20,000-line Markdown documents
* Lockstep input and rendering: stable cursor, no lag, no flicker
* Conflict-free offline and multi-device merging within a paragraph — not paragraph-level LWW
* Real-time multi-editor synchronization with fine-grained merging and remote cursor presence
* Native macOS app, Quick Look preview, local-first web editor, and agent-friendly CLI

[**Try on Web**](https://www.domd.app/editor)

Download for Mac: [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)</sub>

---

## Editor kernel: `@do-md/core-react`

[`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) is the Markdown-native editor kernel behind DOMD. It can be embedded independently in editors, inputs, collaborative workspaces, and AI interfaces. DOMD is a product built with the kernel, not the boundary of what the kernel can do.

The demos linked below isolate individual kernel capabilities, so each one can be evaluated independently of the DOMD application.

### Markdown-native by design

WYSIWYG editing happens directly on Markdown. The Markdown document itself is the editing source of truth.

The kernel is not built on ProseMirror, Slate, Lexical, or any general-purpose rich-text framework. Parsing, rendering, editing, undo/redo, streaming AI injection, and chunked file loading are all modeled as deterministic state changes inside the kernel.

Rendering happens only where changes occur, and the entire editing stack stays just over 30 KB after Brotli compression.

### Extensible inline syntax

Most Markdown tools eventually hit the same wall: inline syntax is fixed. Highlights, mentions, comments, and wikilinks usually mean preprocessing the text, forking the parser, or falling back to raw HTML. In `@do-md/core-react` 0.6, inline syntax is a first-class extension point of the kernel itself.

#### One grammar, from styling to semantics

Parameters follow the Pandoc/Djot inline-attribute family — the closest thing extended Markdown has to a standard, and a convention shared by Pandoc, Quarto, kramdown, and markdown-it. The same grammar scales from a plain highlight to a fully attributed, typed span:

```text
==highlight==                              plain highlight
=={red}highlight==                         tinted — a positional parameter
=={.comment author="Alice"}highlight==     a semantic type with attributes
```

#### Syntax and semantics stay separate

Delimiters carry no meaning of their own. A `.word` selects a **variant** — a semantic type registered as plain data — and the same variant can be attached to whichever delimiters fit your product:

```text
=={.mention id=1}Alice==   ≡   <{.mention id=1}Alice>
```

The Pandoc ecosystem established class-driven semantics as a convention, as in Quarto's `::: {.callout-note}`. The kernel turns that convention into a first-class declarative API. Unregistered types do not cause errors; they degrade gracefully into plain CSS hooks.

#### Variants can become live React UI

A variant can bind a React component. The editor passes it the parsed parameters and children, and the component renders inside the live document. An attribute such as `id` can act as a stable reference to an object in your product, turning a small piece of Markdown into live, interactive UI backed by application data: an issue card with an approval action, a weather widget that refreshes, a workflow control, or any other React experience.

This makes an inline rule more than a styling hook — it can be an embedding surface for product features. A strict render contract keeps the caret, selection, and collaboration machinery safe while the component retains the full React model.

### Conflict-free offline merge

The kernel supports conflict-free merging within a paragraph instead of treating each paragraph as a single last-write-wins value. Two devices can edit different parts of the same paragraph offline, exchange their saved states later, and preserve both changes. Offline state exchange and real-time synchronization share the same CRDT foundation, but can be adopted independently.

The editor kernel itself is CRDT-agnostic. It emits a structured operation stream for ordinary edits; an optional CRDT plugin observes that stream, translates each change into transactions on nested Yjs shared types, and maintains a mergeable `Y.Doc` replica. Yjs encodes that replica as document updates that can be persisted, transferred, and applied in any order. Because the CRDT boundary is an adapter around the operation stream, product and interaction code does not need to be rebuilt around Yjs: a completed editor feature can opt in by attaching the plugin.

[**Try the split-screen CRDT merge playground**](https://www.domd.app/playground/crdt)

### Real-time synchronization

The kernel can keep multiple editors on the same Markdown document synchronized as they type. Fine-grained edits flow to other replicas, concurrent changes converge through Yjs, and remote cursor presence can travel alongside the content. Incoming changes are replayed only onto the affected nodes instead of replacing the document, preserving localized rendering during live editing.

The kernel exposes three integration points for this path: `subscribeRenderDataOps` emits local editing operations, `applyExternalRenderDataOps` incrementally applies remote operations, and cursor snapshots and subscriptions expose presence data. The optional `realtime-sync` adapter translates between these APIs and nested Yjs shared types, providing a reusable synchronization, convergence, and presence layer. It is independent of business workflows and product state, so different editing products can adopt it without rewriting their input, history, or rendering systems.

[**Try the real-time sync playground**](https://www.domd.app/playground/live)

### Streaming

AI models emit Markdown token by token, often splitting in the middle of syntax. The kernel ingests those streams chunk by chunk and renders them live.

Open fences, half-built tables, and partial lists render correctly mid-stream, then absorb their real terminators without flicker when they arrive. Comfortable at any chunk size, through 20,000-line documents and beyond.

[**Try the streaming playground**](https://www.domd.app/playground)

### Markdown-native input

The same kernel can be used as a Markdown-native input surface for comments, prompts, CMS fields, chat boxes, issue forms, or anywhere users write structured text.

Markdown renders while typing, while the underlying value stays Markdown. For chat-style inputs, `Enter` can submit and `Shift + Enter` can insert a new line.

[**Try the input playground**](https://www.domd.app/chat)

---

## DOMD product

DOMD packages the kernel into a deliberately lean, local-first Markdown editor:

* **Large files:** a 5 KB note and a 1 MB document open at virtually the same perceptual speed, with full WYSIWYG rendering rather than a plain-text view.
* **Native macOS app:** a lightweight, ordinary-file workflow with Quick Look preview and no project tree, tabs, account, or bundled sync service. Download for [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) or [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg).
* **Local-first Web editor:** open the editor or drag in a `.md` file; processing stays on the device. [Try DOMD on the Web](https://www.domd.app/editor).
* **Agent-friendly CLI:** `domd-cli` can open windows, stream content into a document, and rewrite selections, making DOMD a local Markdown rendering surface for agents and automation.

Large-file editing in the macOS app:

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

---

## Development

```bash
npm install
npm run dev
```

For native macOS development:

```bash
npm run tauri dev
```

Windows native builds are not currently supported.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for full setup and contribution notes.

---

## Licensing

DOMD is a product-first project with two license layers:

* **Application layer** — the macOS app, web app, helper libraries, and DOMD kernel plugins are open-source under the [MIT License](./LICENSE).
* **Editor kernel** — the core engine lives in this repository at [`.packages/@do-md/core`](./.packages/@do-md/core) (published on npm as [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react)) and is licensed under **GPL-3.0** with two [additional permissions](./.packages/@do-md/core/LICENSE-EXCEPTIONS.md) granted under GPL section 7:

  1. **Small entity exception** — individuals, non-profits, and companies under USD 1M annual revenue and under USD 2M raised may link the kernel into non-GPL software and ship it under terms of their choice.
  2. **FOSS license exception** — projects under MIT, Apache-2.0, BSD, MPL-2.0, ISC, EPL-2.0 or zlib may link the kernel and ship the combined work under their own license.

Because the app bundles the GPL kernel, any binary or web distribution of DOMD as a whole is conveyed under the GPL; the MIT-licensed application sources remain MIT on their own. Trying the kernel, building with it, and running it internally carry no obligations — GPL obligations attach when you ship it to users (and shipping a web app that loads it in the browser counts).

Kernel versions up to and including 0.10.0 were published under the PolyForm Noncommercial 1.0.0 license; from 0.11.0 on, the kernel is GPL-3.0 with the exceptions above.

For proprietary use beyond the exceptions, a commercial license is available — contact <effyouapp@gmail.com>.

---

## Feedback and contributing

* [GitHub Issues](https://github.com/do-md/domd/issues)
* [GitHub Discussions](https://github.com/do-md/domd/discussions)
* [Contributing guide](./CONTRIBUTING.md)
