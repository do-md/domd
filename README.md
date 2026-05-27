<img width="928" height="720" alt="cf0de0fa6d1db4ab27f3f992bf8c81bb_WC-EditVideo_1_30fps" src="https://github.com/user-attachments/assets/ede74d56-f5a8-4e3a-9b6b-6c71bc4cdd22" />


# DOMD

**DOMD is a WYSIWYG editor built on a from-scratch, Markdown-native rendering engine.**

- 20 KB gzipped kernel (zero runtime dependencies beyond React)
- Input and rendering happen in lockstep — cursor stays steady, no lag, no flicker

[**Try on Web**](https://www.domd.app/editor) · Download for Mac: [Apple Silicon](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [Intel](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

<sub>English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)</sub>

---

## Markdown-native

DOMD's WYSIWYG happens directly on Markdown.

Parsing, rendering, editing — engineered for Markdown WYSIWYG from the first line of code.

It is not built on top of ProseMirror, Slate, Lexical, or any general-purpose rich-text framework.

DOMD's edit model serves Markdown directly.

---

## Kernel

DOMD's kernel is a from-scratch Markdown WYSIWYG editor engine.

It is driven by a single source of truth — data — with immutable state. Typing, undo/redo, incremental streaming AI injection, and chunked file loading are all modeled as the same kind of state change inside the kernel.

This makes editing behavior deterministic, state always traceable, and rendering happens only where changes occur.

The entire editing stack fits in 20 KB gzipped.

---

## Instant 1 MB open

https://github.com/user-attachments/assets/d4cb6d94-6efe-4d5d-8a67-846be7f3cd45

A 5 KB note and a 1 MB document open at virtually the same perceptual speed.

In Finder, press space — DOMD's own Quick Look extension takes over rendering.

---

## macOS

The Mac experience is built to the bar of system apps. Loading a rendered `.md` feels close to the system opening a `.txt`.

The purest Markdown preview and editing — no project tree, no sidebar, no tabs, no sync, no account. Files stay on your device.

Download for macOS: [**Apple Silicon**](https://github.com/do-md/domd/releases/latest/download/DOMD_aarch64.dmg) · [**Intel**](https://github.com/do-md/domd/releases/latest/download/DOMD_x86_64.dmg)

## Web

Open the editor and start writing WYSIWYG in the browser — or drag a `.md` straight onto the page to edit it in place. Everything runs locally; files never leave your device.

https://www.domd.app

---

## CLI

The macOS build ships with a command-line tool `domd-cli` that lets agents drive the window directly.

It supports opening new windows, streaming writes, and rewriting selections. A model's streaming response can be piped straight into `domd-cli insert` — tokens land in the document as they arrive and render as rich text in real time.

The demo at the top of the page was recorded from an Alfred workflow that calls the GPT API and streams the response incrementally into the document.

*(Full command documentation will be published with the first Release.)*

---

## Build

```bash
npm install
npm run dev              # web
npm run tauri dev        # macOS native
```

macOS builds are signed for Apple Silicon. Intel and Windows are not currently supported.

---

## License

DOMD is dual-licensed.

**Application layer & helper libraries** — All source in this repository, including `@do-md/utils` and `@do-md/zenith`, is MIT licensed; see [LICENSE](LICENSE). Free to read, modify, and self-host.

**Core rendering engine** — `@do-md/dist` is distributed as a build artifact only, under [PolyForm Noncommercial 1.0.0](.packages/@do-md/dist/LICENSE). **Any commercial use requires prior written authorization.**

---

## Feedback

GitHub Issues and Discussions (links published after the first Release).
