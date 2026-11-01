/**
 * Headless matrix for the clipboard serializers behind `copyAs`.
 * Run: sh scripts/verify-copy/run.sh
 *
 * The controller cuts a selection out of a marker-injected serialization of
 * the whole model; this pins both halves headlessly: toPlainText's document
 * output ("text" flavor), and the slice between the two CursorMarkers for
 * selections given in render coordinates (block uuid + offset in the block's
 * source text — the coordinate getCursorInfo + adjustCursor_ hand over).
 * The DOM half (event wiring, clipboardData, view-only offsets) needs a
 * real browser.
 */
import { EditorStore, MarkdownType, toMarkdown } from "../../src";
import type { AnyRenderData, CursorInfo } from "../../src";
import { toPlainText } from "../../src/editor/model/serialize/toPlainText";
import { CursorMarker } from "../../src/editor/constant";

let passes = 0;
let failures = 0;

const eq = (name: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passes += 1;
        return;
    }
    failures += 1;
    console.error(
        `FAIL: ${name}\n     got: ${JSON.stringify(actual)}\n  expect: ${JSON.stringify(expected)}`,
    );
};

const createStore = (initMd: string) =>
    new EditorStore({ initMd, editable: false });

const root = (store: EditorStore) =>
    store.state.renderData_ as unknown as AnyRenderData;

/** Render elements (nodes carrying data-render-id) of a type, in order. */
const renderNodes = (node: AnyRenderData, type: MarkdownType): AnyRenderData[] => {
    const out: AnyRenderData[] = [];
    const visit = (n: AnyRenderData) => {
        if (n.htmlType_ === type && n.htmlProps_?.["data-render-id"]) out.push(n);
        for (const child of n.children_ ?? []) visit(child);
    };
    visit(node);
    return out;
};

const cursor = (node: AnyRenderData, offset: number): CursorInfo => ({
    uuid: node.uuid_,
    offset,
});

/** Same slicing rule as EditorController.serializeSelection_. */
const slice = (text: string) => {
    const first = text.indexOf(CursorMarker);
    const last = text.lastIndexOf(CursorMarker);
    if (first === -1) return null;
    return first === last
        ? text.slice(0, first)
        : text.slice(first + CursorMarker.length, last);
};

const plainSelection = (store: EditorStore, cursors: CursorInfo[]) =>
    slice(toPlainText(root(store), cursors));
const markdownSelection = (store: EditorStore, cursors: CursorInfo[]) =>
    slice(toMarkdown(root(store), cursors));

// ---------------------------------------------------------------- documents
const docs: [string, string, string][] = [
    [
        "link text only, url dropped",
        "链接：[https://x.cn/a](https://x.cn/a) 提取码",
        "链接：https://x.cn/a 提取码",
    ],
    ["labelled link", "see [the docs](http://d.io) now", "see the docs now"],
    ["autolink", "<https://a.b> x", "https://a.b x"],
    ["bare url", "go https://a.b/c now", "go https://a.b/c now"],
    ["heading", "# Title", "Title"],
    ["heading with highlight rule", "## A ==hi== B", "A hi B"],
    [
        "inline marks",
        "**b** *i* ***bi*** ~~s~~ `c`",
        "b i bi s c",
    ],
    ["inline html", "x<sup>2</sup> H<sub>2</sub>O", "x2 H2O"],
    ["escapes", "\\*not em\\* a\\_b", "*not em* a_b"],
    ["soft break", "line one\nline two", "line one\nline two"],
    ["paragraphs", "a\n\nb", "a\n\nb"],
    ["bullet list", "- a\n- b\n  - c", "a\nb\nc"],
    ["ordered list", "1. one\n2. two", "one\ntwo"],
    ["checklist", "- [ ] todo\n- [x] done", "todo\ndone"],
    ["blockquote", "> q1\n>\n> q2", "q1\n\nq2"],
    [
        "table as TSV",
        "| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n| c3 | c4 |",
        "h1\th2\nc1\tc2\nc3\tc4",
    ],
    ["code block", "```js\nconst a = 1;\nlet b;\n```", "const a = 1;\nlet b;"],
    ["empty code block", "```\n```", ""],
    ["thematic break", "a\n\n---\n\nb", "a\n\n---\n\nb"],
    ["image", "x ![alt](http://i/p.png) y", "x  y"],
    ["html block keeps its source", "<div>raw</div>", "<div>raw</div>"],
    [
        "mixed document",
        "# T\n\npara **b**\n\n- one\n- two\n\n> q",
        "T\n\npara b\n\none\ntwo\n\nq",
    ],
];
for (const [name, md, expected] of docs) {
    eq(`doc: ${name}`, toPlainText(root(createStore(md))), expected);
}

// Markdown flavor is untouched: the whole-document clipboard text is toMarkdown.
{
    const md = "# T\n\n链接：[u](http://u) **b**";
    const store = createStore(md);
    eq("markdown doc = toMarkdown", toMarkdown(root(store)), md);
}

// --------------------------------------------------------------- selections
{
    // The issue #46 shape: a link whose text is its URL.
    const url = "https://pan.quark.cn/s/44f85cd2cc4d";
    const md = `链接：[${url}](${url}) 提取码`;
    const store = createStore(md);
    const [p] = renderNodes(root(store), MarkdownType.P);
    const urlStart = "链接：[".length;
    const urlEnd = urlStart + url.length;

    eq("link url: text", plainSelection(store, [cursor(p, urlStart), cursor(p, urlEnd)]), url);
    eq("link url: markdown", markdownSelection(store, [cursor(p, urlStart), cursor(p, urlEnd)]), url);
    eq(
        "link url, start before the hidden [: text",
        plainSelection(store, [cursor(p, urlStart - 1), cursor(p, urlEnd)]),
        url,
    );
    eq(
        "last four chars: text",
        plainSelection(store, [cursor(p, urlEnd - 4), cursor(p, urlEnd)]),
        "cc4d",
    );
    eq(
        "whole line: text",
        plainSelection(store, [cursor(p, 0), cursor(p, md.length)]),
        `链接：${url} 提取码`,
    );
    eq(
        "whole line: markdown keeps the source",
        markdownSelection(store, [cursor(p, 0), cursor(p, md.length)]),
        md,
    );
    eq(
        "reversed endpoints: text",
        plainSelection(store, [cursor(p, urlEnd), cursor(p, urlStart)]),
        url,
    );
    eq(
        "collapsed selection: empty",
        plainSelection(store, [cursor(p, 3), cursor(p, 3)]),
        "",
    );
    eq(
        "selection ending inside the hidden ](url): text",
        plainSelection(store, [cursor(p, 0), cursor(p, urlEnd + 5)]),
        `链接：${url}`,
    );
}

{
    // Across blocks: heading (source offsets count "# ") into a paragraph.
    const store = createStore("# Title\n\nbody **bold** end");
    const [h1] = renderNodes(root(store), MarkdownType.H1);
    const [p] = renderNodes(root(store), MarkdownType.P);
    eq(
        "heading -> paragraph: text",
        plainSelection(store, [cursor(h1, 2), cursor(p, "body **bo".length)]),
        "Title\n\nbody bo",
    );
    eq(
        "heading -> paragraph: markdown",
        markdownSelection(store, [cursor(h1, 2), cursor(p, "body **bo".length)]),
        "Title\n\nbody **bo",
    );
}

{
    // Table cells: the render elements are the cell paragraphs.
    const store = createStore("| h1 | h2 |\n| --- | --- |\n| c1 | c2 |");
    const cells = renderNodes(root(store), MarkdownType.P);
    eq(
        "table c1 -> c2: text",
        plainSelection(store, [cursor(cells[2], 0), cursor(cells[3], 2)]),
        "c1\tc2",
    );
    eq(
        "table header row -> body: text",
        plainSelection(store, [cursor(cells[0], 0), cursor(cells[3], 2)]),
        "h1\th2\nc1\tc2",
    );
}

{
    // List items and checklist items.
    const store = createStore("- [ ] todo\n- [x] done\n- plain");
    const ps = renderNodes(root(store), MarkdownType.P);
    eq(
        "checklist across items: text",
        plainSelection(store, [cursor(ps[0], 1), cursor(ps[2], 5)]),
        "odo\ndone\nplain",
    );
}

{
    // Code block lines are PreCode render elements.
    const store = createStore("```js\nconst a = 1;\n```");
    const [code] = renderNodes(root(store), MarkdownType.PreCode);
    eq(
        "code partial: text",
        plainSelection(store, [cursor(code, 6), cursor(code, 7)]),
        "a",
    );
}

{
    // Coordinates that resolve to nothing: no marker, nothing to copy.
    const store = createStore("abc");
    eq(
        "unknown uuid: null",
        plainSelection(store, [{ uuid: "missing", offset: 0 }, { uuid: "missing", offset: 1 }]),
        null,
    );
}

console.log(`verify-copy: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
