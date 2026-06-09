<img width="928" height="720" alt="cf0de0fa6d1db4ab27f3f992bf8c81bb_WC-EditVideo_1_30fps" src="https://github.com/user-attachments/assets/ede74d56-f5a8-4e3a-9b6b-6c71bc4cdd22" />

# DOMD

**A WYSIWYG Markdown editor powered by a 20 KB, from-scratch, Markdown-native engine.**

Built for fast human editing, huge Markdown files, and real-time AI streaming.

* 20 KB Brotli-compressed kernel, with only React and Immer as runtime dependencies
* Smooth editing and streaming through 20,000-line Markdown documents
* Lockstep input and rendering: stable cursor, no lag, no flicker
* Native macOS app, Quick Look preview, local-first web editor, and agent-friendly CLI

[**Try on Web**](https://www.domd.app/editor) · [**Streaming Playground**](https://www.domd.app/playground) · [**Input Playground**](https://www.domd.app/chat)

Download for Mac: [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)</sub>

---

## Markdown-native kernel

DOMD's WYSIWYG editing happens directly on Markdown.

The Markdown document itself is the editing source of truth.

It is not built on top of ProseMirror, Slate, Lexical, or any general-purpose rich-text framework. Parsing, rendering, editing, undo/redo, streaming AI injection, and chunked file loading are all modeled as deterministic state changes inside the kernel.

Rendering happens only where changes occur, and the entire editing stack fits in 20 KB Brotli-compressed.

---

## Streaming

AI models emit Markdown token by token, often splitting in the middle of syntax. DOMD ingests those streams chunk by chunk and renders them live.

Open fences, half-built tables, and partial lists render correctly mid-stream, then absorb their real terminators without flicker when they arrive. Comfortable at any chunk size, through 20,000-line documents and beyond.

[**Try the streaming playground**](https://www.domd.app/playground)

---

## Markdown-native input

DOMD can also be used as a Markdown-native input surface for comments, prompts, CMS fields, chat boxes, issue forms, or anywhere users write structured text.

Markdown renders while typing, while the underlying value stays Markdown. For chat-style inputs, `Enter` can submit and `Shift + Enter` can insert a new line.

[**Try the input playground**](https://www.domd.app/chat)

---

## Large-file performance

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

A 5 KB note and a 1 MB document open at virtually the same perceptual speed.

This is rendered WYSIWYG Markdown, not a plain-text viewer.

In Finder, press space — DOMD's own Quick Look extension takes over rendering.

---

## macOS

The Mac app is designed to feel lightweight and native. Loading a rendered `.md` feels close to the system opening a `.txt`.

A plain Markdown file workflow — no project tree, no sidebar, no tabs, no sync, no account. Files stay on your device.

Download for macOS: [**Apple Silicon**](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [**Intel**](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

---

## Web

Open the editor and start writing WYSIWYG in the browser — or drag a `.md` straight onto the page to edit it in place. Everything runs locally; files never leave your device.

<https://www.domd.app>

---

## CLI

The macOS build ships with a command-line tool `domd-cli` that lets agents drive the window directly.

This turns DOMD into a local Markdown rendering surface for agents, scripts, launchers, and automation tools.

It supports opening new windows, streaming writes, and rewriting selections. A model's streaming response can be piped straight into `domd-cli insert` — tokens land in the document as they arrive and render as rich text in real time.

The demo at the top of the page was recorded from an Alfred workflow that calls the GPT API and streams the response incrementally into the document.

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

DOMD is a product-first project. The application layer, including the macOS app, web app, and helper libraries, is open-source under their respective licenses for learning, personal use, contribution, and transparency.

The core editor engine, `@do-md/dist`, is separately licensed and distributed as a prebuilt build artifact under the PolyForm Noncommercial 1.0.0 license. It includes DOMD's Markdown editing and rendering capabilities.

You may use `@do-md/dist` for evaluation, personal projects, non-commercial projects, including non-commercial open-source projects, experiments, and prototypes.

Commercial use requires prior written authorization. This includes commercial embedding, SaaS/product integration, redistribution, or offering DOMD as part of a paid product, SDK, editor component, or hosted service.

For commercial licensing, please contact the project author.

---

## Feedback and contributing

* [GitHub Issues](https://github.com/do-md/domd/issues)
* [GitHub Discussions](https://github.com/do-md/domd/discussions)
* [Contributing guide](./CONTRIBUTING.md)
