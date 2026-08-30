# DoMD Plugins

First-party plugins and extensions for [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react), the DoMD markdown WYSIWYG editor kernel.

The kernel ships **mechanisms** (text replacement, selection addressing, an op stream, render-component injection); these packages ship **policies** built on those public APIs — named commands, sync bindings, replacement renderers. Every package here talks to the kernel exclusively through its published, mangle-stable surface: if it works for these plugins, it works for yours.

## Packages

| Package | Description |
|---|---|
| [`commands`](./commands) | Named editing commands — heading/list/quote/code-block toggles, table & divider insertion, links, clear-formatting, a block-format state reader, and a keyboard shortcut binder. The `prosemirror-schema-list` of DoMD. |
| [`toc`](./toc) | Headless document outline (table of contents) — a flat heading list extracted from the model snapshot, kept in sync through the op stream, plus scroll spy and click-to-jump over the block uuid DOM contract. |

More to come: realtime sync (Yjs binding), table renderer with row/column affordances, custom cursor overlay.

## Structure

Each top-level directory is one independently published npm package (`@do-md/<name>`), with its own `package.json`, `tsconfig.json` and `src/`. There is no root build — packages are built and released individually.

These packages live in the DoMD app repository at `apps/domd/.packages/@do-md/plugins/`, alongside the kernel at `../core/`. The app consumes their **source** through tsconfig paths, so an edit here is live in the app with no publish step in between. That is also why every package imports extensionlessly (bundler resolution) and publishes a single bundled file — `commands/vite.config.ts` carries the full reasoning.

## Development

```bash
cd commands
npm install        # .npmrc keeps the kernel's peers (react, immer) out of this subtree
npm run typecheck  # against the published kernel .d.ts, exactly as a consumer sees it
npm run build      # dist/index.js (rollup) + dist/index.d.ts (api-extractor)
```

## License

Everything in this directory is [MIT](./LICENSE).

The editor kernel `@do-md/core-react` is licensed separately: GPL-3.0 with two additional permissions under section 7 (see the kernel's `LICENSE` and `LICENSE-EXCEPTIONS.md`), plus commercial licensing. Every package here talks to the kernel through its published API only, so the set doubles as living documentation of that extension surface.
