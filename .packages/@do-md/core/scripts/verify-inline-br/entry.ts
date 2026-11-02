/**
 * Inline raw HTML `<br>` assertion matrix.
 * Run: sh scripts/verify-inline-br/run.sh
 *
 * `<br>` is inline raw HTML in CommonMark and GitHub renders it as a hard
 * line break. DOMD parsed the other bare inline tags (`<u>`, `<ins>`, …) but
 * let `<br>` fall through to literal text, because the inline-tag branch only
 * matched paired tags. That is visible wherever a newline cannot be written any
 * other way — most commonly a GFM table cell from an AI answer
 * (`| 4%<br>重置 18:18 |`) and mid-paragraph (`第一行<br>第二行`).
 *
 * Contract asserted here:
 *   1. `<br>`, `<br/>`, `<br />` (any case) produce one Br node — the same
 *      node a Shift+Enter-style hard break renders — instead of a text leaf
 *      containing the tag;
 *   2. the source tag stays in a hidden MdSymbol, so Markdown round-trip is
 *      byte-exact (`toMarkdown(parseMarkdown(md)) === md`);
 *   3. the surrounding content is untouched (spans before/after, table cells,
 *      nested inline tags, code fences) and non-`br` autolinks still parse;
 *   4. a bare `<br>` at the start of a line reaches the inline parser too
 *      (the HTML-block path used to swallow it first).
 */
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import { MarkdownType } from "../../src/editor/type/enum";
import { ParentRenderData, RenderData } from "../../src/editor/type";

/* eslint-disable no-console */
const rawLog = console.log.bind(console);
console.log = () => {};
console.time = () => {};
console.timeEnd = () => {};

let passes = 0;
let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
        passes += 1;
    } else {
        failures += 1;
        rawLog(`FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
    }
};

type AnyNode = ParentRenderData | RenderData;

const findAll = (node: AnyNode, type: MarkdownType): AnyNode[] => {
    const out: AnyNode[] = [];
    const walk = (n: AnyNode) => {
        if (n.htmlType_ === type) out.push(n);
        (n as ParentRenderData).children_?.forEach(walk);
    };
    walk(node);
    return out;
};

const isSymbol = (node: AnyNode) =>
    node.htmlType_ === MarkdownType.MdSymbol ||
    node.htmlType_ === MarkdownType.MdHideSymbol;

/** Text a reader would see: hidden markdown symbols carry no visible text. */
const visibleText = (node: AnyNode): string => {
    const children = (node as ParentRenderData).children_;
    if (children?.length) {
        return children.filter((child) => !isSymbol(child)).map(visibleText).join("");
    }
    return isSymbol(node) ? "" : (node.text_ ?? "");
};

const roundTrip = (md: string) => toMarkdown(parseMarkdown(md));

const brNodes = (md: string) => findAll(parseMarkdown(md), MarkdownType.Br);

// 1. Mid-paragraph break: one Br node, no literal tag in the visible text.
{
    const md = "第一行<br>第二行";
    const tree = parseMarkdown(md);
    check("paragraph: one Br node", brNodes(md).length === 1, {
        count: brNodes(md).length,
    });
    check("paragraph: visible text drops the tag", visibleText(tree) === "第一行第二行", visibleText(tree));
    check("paragraph: byte-exact round-trip", roundTrip(md) === md, roundTrip(md));
}

// 2. GFM table cell — the AI answer shape that surfaced this: a cell has no
//    newline of its own, so `<br>` is the only way to write two lines in it.
{
    const md = [
        "| 账号 | 5 小时滚动 | 状态 |",
        "| --- | --- | --- |",
        "| 账号1 | 4%<br>重置 11-02 18:18 | 健康 |",
        "| 账号2 | 12%<br>重置 11-02 18:18 | 健康 |",
    ].join("\n");
    const tree = parseMarkdown(md);
    check("table: one Br node per cell", brNodes(md).length === 2, {
        count: brNodes(md).length,
    });
    const tds = findAll(tree, MarkdownType.TD);
    const percentCell = tds.find((td) => visibleText(td).startsWith("4%"));
    check("table: cell keeps both sides of the break", percentCell !== undefined && visibleText(percentCell) === "4%重置 11-02 18:18", percentCell && visibleText(percentCell));
    const serialized = toMarkdown(tree);
    check("table: serializer keeps the tag", serialized.includes("4%<br>重置"), serialized);
    check("table: canonical reparse is a fixed point", toMarkdown(parseMarkdown(serialized)) === serialized);
}

// 3. Spellings: self-closing (with and without space) and any case — the
//    hidden symbol keeps the exact source, so round-trip stays byte-exact.
for (const tag of ["<br/>", "<br />", "<BR>", "<Br/>"]) {
    const md = `前${tag}后`;
    check(`spelling ${tag}: one Br node`, brNodes(md).length === 1);
    check(`spelling ${tag}: round-trip`, roundTrip(md) === md, roundTrip(md));
}

// 4. Nested inside a paired inline tag — the inline parser recurses content.
{
    const md = "<u>a<br>b</u>";
    const tree = parseMarkdown(md);
    check("nested in <u>: Br exists", findAll(tree, MarkdownType.Br).length === 1);
    check("nested in <u>: visible text", visibleText(tree) === "ab", visibleText(tree));
    check("nested in <u>: round-trip", roundTrip(md) === md, roundTrip(md));
}

// 5. A line that *starts* with a bare `<br>` must reach the inline parser;
//    the block-HTML path used to claim it and show the tag as text.
{
    const md = "<br>继续";
    const tree = parseMarkdown(md);
    const topLevel = (tree.children_ || []).map((child) => String(child.htmlType_));
    check("leading <br>: paragraph, not HTML block", !topLevel.includes(String(MarkdownType.HTML)), topLevel);
    check("leading <br>: one Br node", findAll(tree, MarkdownType.Br).length === 1);
    check("leading <br>: round-trip", roundTrip(md) === md, roundTrip(md));
}

// 6. Non-regressions: autolinks and code fences are untouched.
{
    const autolink = "<https://example.com>";
    const tree = parseMarkdown(autolink);
    check("autolink still a Link", findAll(tree, MarkdownType.Link).length === 1);
    check("autolink has no Br", findAll(tree, MarkdownType.Br).length === 0);
    check("autolink round-trip", roundTrip(autolink) === autolink, roundTrip(autolink));
}
{
    const fence = "```\n<br>\n```";
    const tree = parseMarkdown(fence);
    check("code fence: no Br node", findAll(tree, MarkdownType.Br).length === 0);
    check("code fence: round-trip", roundTrip(fence) === fence, roundTrip(fence));
}

// 7. Attributes are out of scope: like every other bare inline tag, `<br
//    class="x">` is not an inline candidate and stays literal text.
{
    const md = '前<br class="x">后';
    check("attrs stay literal", brNodes(md).length === 0);
    check("attrs round-trip", roundTrip(md) === md, roundTrip(md));
}

rawLog(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
