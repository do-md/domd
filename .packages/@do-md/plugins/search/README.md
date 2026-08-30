# @do-md/search

Headless find & replace for [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react) — VSCode-semantics matching, a [zenith](https://www.npmjs.com/package/@do-md/zenith) store, and CSS Custom Highlight painting. Bring your own widget UI.

## What it does

- **Matching** (`compileQuery` / `findMatches`): literal or regex, case sensitivity, VSCode-style whole-word boundaries, match limit with explicit `limitHit`. The search space is the **markdown source** (`toMarkdown()`), the same coordinate space the kernel's replace family addresses — every match range feeds `setSelection` / `replaceRanges` / `resolveRanges` verbatim.
- **State machine** (`SearchStore`): open/close, query & options, match count, wrap-around navigation, replace one / replace all. Replace-all is a single `replaceRanges` call — one undo step, fine-grained collab ops. Regex replacements expand `$1`/`$&`/`$$` from groups captured at scan time; preserve-case mirrors VSCode's AB toggle.
- **Painting** (`bindSearchPainter`): every match painted through the CSS Custom Highlight API (`::highlight(domd-search)` / `::highlight(domd-search-active)`), anchored via the kernel's `resolveRanges` (>=0.11.7) and positioned the way remote cursors are drawn. No DOM mutation, no overlay rectangles. On kernels or browsers without the capability the engine still counts, navigates and replaces — it just paints nothing.

Navigation deliberately never moves the model selection (that would fight the find input for focus and broadcast presence noise); the selection is placed once, on `close()`, landing the caret on the current match.

## Usage sketch (React host)

```tsx
const search = useMemo(() => new SearchStore(), []);
useEffect(() => search.attach(editorStore), [search, editorStore]);
useEffect(
    () => bindSearchPainter(search, editorStore, editorContainerEl),
    [search, editorStore, editorContainerEl],
);
```

Style the highlights in your CSS:

```css
::highlight(domd-search) { background-color: rgb(180 160 60 / 0.35); }
::highlight(domd-search-active) { background-color: rgb(200 130 60 / 0.6); }
```

## License

MIT.
