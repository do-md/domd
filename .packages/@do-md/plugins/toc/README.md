# @do-md/toc

Headless document outline (table of contents) for [`@do-md/core-react`](https://www.npmjs.com/package/@do-md/core-react), the DoMD markdown WYSIWYG editor kernel.

Everything runs on the kernel's published, mangle-stable surface: the outline is extracted from `getRenderDataSnapshot()` (stable keys `type`/`uuid`/`text`/`children`), kept fresh through `subscribeRenderDataOps()` behind a cheap op relevance filter (typing inside a paragraph never rescans), and located in the DOM through the block uuid contract (`data-render-id`). No text matching, no internal fields.

## Layers

- **`outline`** — pure functions: snapshot → flat heading list `{uuid, level, depth, text}`. Real levels are never normalized; `depth` follows the nearest-shallower-predecessor rule (Docusaurus/VS Code semantics), entry text is plain text with all markdown markers stripped, and headings inside blockquotes are excluded (quoted content is not document structure).
- **`TocStore`** — a zenith store: `attach(editorStore)` scans and subscribes, `state.headings` is the outline, `state.activeUuid` the scroll-spy result.
- **`spy`** — the DOM half: `bindTocSpy(store, scrollContainer)` (scroll-event flavor, rAF-coalesced, three-rule active-heading arbitration) and `scrollToHeading(scope, uuid)`.
- **`react`** — `TocStoreProvider` / `useTocStoreApi` / `useTocStore` (zenith `createReactStore`, the kernel's own posture).

## Usage

```tsx
<TocStoreProvider>
    {/* somewhere with the editor store + scroll container */}
    <OutlineWiring />
    <OutlinePanel />
</TocStoreProvider>

function OutlineWiring() {
    const editor = useEditorStoreApi();
    const toc = useTocStoreApi();
    useEffect(() => (editor ? toc.attach(editor) : undefined), [editor, toc]);
    useEffect(() => bindTocSpy(toc, scrollContainerEl), [toc]);
    return null;
}

function OutlinePanel() {
    const headings = useTocStore((s) => s.state.headings);
    const activeUuid = useTocStore((s) => s.state.activeUuid);
    // render; on click: scrollToHeading(editorRootEl, heading.uuid)
}
```

## Verification

```bash
sh scripts/verify-toc/run.sh   # headless matrix against the real kernel EditorStore
```

## License

MIT.
