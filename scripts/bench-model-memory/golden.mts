/**
 * Parse-equivalence golden for the O(n^2) extractor fix (kernel
 * data-parse/gettext). Run once against the pre-fix dist to capture a
 * baseline, rebuild the kernel with the fix, run again and diff — the
 * uuid-stripped model structure and the toMarkdown round-trip must be
 * byte-identical for every fixture.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/bench-model-memory/golden.mts > /tmp/golden-<label>.json
 *
 * Fixtures deliberately concentrate on the edges of the rewritten
 * extractors: UL/OL area extent (nesting, loose blank lines, continuation
 * indentation, EOF), blockquote extent, table extent (per-line trim,
 * indented rows, EOF with/without newline, pipe-but-not-table), heading
 * prefix probing (1-6 hashes, 7 hashes, no space, EOF), plus untouched
 * neighbours (fences, hr, html) as regression canaries.
 */
import { EditorStore, serializeRenderData } from "@do-md/core-react";

const FIXTURES: Record<string, string> = {
    // --- unordered lists (getULAreaText) ---
    ulFlat: "- one\n- two\n- three\n\nafter paragraph\n",
    ulNested: "- parent\n  - child a\n  - child b\n- second parent\n\ntail\n",
    ulLooseBlankInside: "- one\n\n- two after blank\n- three\n\nnot a list\n",
    ulContinuationIndent:
        "- item with body\n  continuation line one\n  continuation line two\n- next item\n\npara\n",
    ulDeepIndent: "- a\n  - b\n    - c\n      - d\n- back to top\n",
    ulAtEof: "text before\n\n- last\n- list",
    ulTrailingBlanks: "- one\n- two\n\n\n\nnext paragraph\n",
    ulStopsAtText: "- one\n- two\nplainly outdented text stops the list\n",
    ulThenTable: "- item\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    // --- ordered lists (getOLAreaText) ---
    olFlat: "1. first\n2. second\n3. third\n\nafter\n",
    olNested: "1. first\n   1. sub one\n   2. sub two\n2. second\n\ntail\n",
    olContinuation: "1. item\n   hanging body line\n2. next\n\npara\n",
    olLooseBlank: "1. one\n\n2. two\n\nnot list anymore\n",
    olAtEof: "para\n\n1. a\n2. b",
    olStartAtFive: "5. five\n6. six\n\npara\n",
    // --- blockquotes (getBlockquoteAreaText) ---
    bqSimple: "> quoted line one\n> quoted line two\n\nafter\n",
    bqNested: "> outer\n> > inner\n> outer again\n\ntail\n",
    bqStopsAtPlain: "> quote\nplain line right after\n",
    bqAtEof: "para\n\n> closing quote",
    // --- tables (extractTableText) ---
    tableBasic: "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n",
    tableAligned: "| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n\ntail\n",
    tableAtEofNoNewline: "before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    tableAtEofNewline: "before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    tableTrailingSpaces:
        "| a | b |  \n| --- | --- |\n| 1 | 2 |   \n\nafter\n",
    tableIndentedRows:
        "| a | b |\n| --- | --- |\n  | 1 | 2 |\n| 3 | 4 |\n\ntail\n",
    tableThenText: "| a | b |\n| --- | --- |\n| 1 | 2 |\nno pipe here\n",
    tableBlankBreaks:
        "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |\n",
    pipeNotATable: "| just a pipe line without separator\nmore text\n",
    pipeSingleLine: "| lonely |",
    // --- headings (getHeaderAreaText) ---
    headings: "# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n",
    sevenHashes: "####### not a heading\n\npara\n",
    hashNoSpace: "#nospace stays paragraph\n",
    headingAtEof: "para\n\n## last heading",
    headingTightList: "## heading\n- tight list right under\n- two\n",
    headingTightTable: "## heading\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    // --- untouched neighbours as canaries ---
    fenceBasic: "```js\nconst x = 1;\nconsole.log(x);\n```\n\nafter\n",
    fenceUnclosed: "para\n\n```js\nconst dangling = true;\n",
    fenceWithPipesAndDashes: "```\n| a | b |\n- not a list\n# not a heading\n```\n",
    hrVariants: "---\n\ntext\n\n***\n\ntext\n\n___\n",
    htmlBlock: '<div class="wrap">\n<b>bold</b>\n</div>\n\npara\n',
    softBreakParagraph: "line one\nline two\nline three\n\nnext para\n",
    emptyDoc: "",
    onlyNewlines: "\n\n\n",
    mixedKitchenSink:
        "# Title\n\nIntro paragraph with **bold** and a [link](https://e.com).\n\n- list a\n  - nested\n- list b\n\n1. one\n2. two\n\n> quote line\n> second line\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n\n```ts\nconst v: number = 42;\n```\n\n---\n\nfinal words\n",
};

// serializeRenderData stable keys include uuid and uuid-bearing props —
// strip anything random so two parses of the same text compare equal.
const STRIP_KEYS = new Set([
    "uuid",
    "data-render-id",
    "data-span-render-id",
    "data-atomic-render-id",
]);
const stripUuids = (value: unknown): string =>
    JSON.stringify(value, (key, v) => (STRIP_KEYS.has(key) ? undefined : v));

const out: Record<string, { structure: string; roundTrip: string }> = {};
for (const [name, md] of Object.entries(FIXTURES)) {
    const store = new EditorStore({ editable: true, initMd: "" });
    store.resetMD(md);
    const root = (store as unknown as { renderData_: unknown }).renderData_;
    out[name] = {
        structure: stripUuids(serializeRenderData(root as never)),
        roundTrip: store.toMarkdown(),
    };
}
console.log(JSON.stringify(out, null, 1));
