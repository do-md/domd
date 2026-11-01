# Long-document latency benchmark

DOMD measured the way ponjo measures its editor views in
[`test/perf/latency.test.js`](https://github.com/ponjo-app/ponjo/blob/main/test/perf/latency.test.js)
(context: [ponjo-app/ponjo#212](https://github.com/ponjo-app/ponjo/issues/212)).

```bash
cd apps/domd/scripts/bench-latency
npm install --include=dev
npx playwright install chromium          # unless you pass --electron
node run.mjs                             # all cases, configs A, B and C, 3 runs each
node run.mjs --electron <path/to/Electron>   # same engine as a ponjo run
node run.mjs --cases blocks-1m,verses-20k --configs B --runs 1
node run.mjs --caret model ...           # caret at 0.1% of the whole doc (see below)
node run.mjs --profile typing --no-minify ...   # CPU profile of the typing phase
```

What is measured:

- **Input.** The docs come from ponjo's own generators, `blocks(chars)` and
  `verses(chars)`, copied verbatim into `shapes.mjs` (MIT, Fan Zhang).
- **Editor.** The published kernel, `@do-md/core-react@0.13.1` from npm, in a
  production React build. Nothing else from the app is on the page. Config A
  is the kernel alone. Config B adds `@do-md/virtual` in `auto` mode, as the
  DOMD app ships it. That package is not on npm yet, so it is bundled from
  `.packages/@do-md/plugins/virtual/src`. A and B apply the teammate's edit
  by text offset with `replaceRanges`, which is what an OT text op would map
  to. Config C is B, except the teammate's edit arrives as DOMD's own
  `RenderDataOp`s, which is how DOMD collaborates. The teammate there is a
  headless store in a Web Worker, seeded from the same tree. The ops are
  delivered in order with no CRDT in between, so local typing is committed
  before the teammate edits. Its side is not timed. Committing local typing
  and applying its ops with `applyExternalRenderDataOps` are timed.
- **Procedure.** It follows ponjo's: open the doc, put a DOM caret at 0.1% of
  the editable's text, then send `Input.insertText 'x'` over CDP 40 times,
  150 ms apart. After every second key, a teammate's `'y'` lands three
  characters before the end. The window is 1000×700. Every run gets a fresh
  browser.
- **Caret.** By default the caret goes at 0.1% of the editable's DOM text,
  as ponjo's `caretAt` does. With virtualization, only a window of the doc
  is in the DOM, so that lands at the very start. `--caret model` puts it
  at 0.1% of the whole doc through `setSelection` instead. Results depend
  a lot on the kind of block the caret lands in, and each run records where
  it landed.

| Column | DOMD | ponjo's equivalent |
| --- | --- | --- |
| Open: first editable | store constructed → first chunk rendered and editable, next frame | (none) |
| Open: whole doc | until `isLoadingChunks` is false, next frame | `collab.make` until `getText` (also includes its doc host setup) |
| Keystroke | CDP `Input.insertText` round trip | same |
| Key → next frame | `beforeinput` timestamp → the frame after it | (none) |
| Teammate | A/B: the `store.replaceRanges` call. C: the `applyExternalRenderDataOps` call. Both commit pending typed text first. | `before + applyText` per batch |
| Teammate → next frame | the same call → the frame after it | (none) |
| Longest task | longest `longtask` from the end of the open to the end of the run | same window |
| Longest task during load | longest `longtask` while the doc streams in | (none) |
| Typed text intact | all 40 `x` and 20 `y` in place, and the rest equal to the doc as DOMD opened it | (none) |

DOMD commits typed text to its model 400 ms after the last key (the browser
updates the DOM at once). With a teammate edit every 300 ms, that commit
usually happens inside the teammate call, so its cost shows up in the
Teammate column. `flushes` in the JSON times each commit on its own.

The page wraps `applyPendingText_` and `appendMarkdownIncremental_` on the
store instance to time them. It changes nothing else. Results are written to
`results/<stamp>.json`.
