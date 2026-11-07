/**
 * Inline raw HTML `<br>` assertion matrix.
 * Run: sh scripts/verify-inline-br/run.sh
 *
 * `<br>` is inline raw HTML in CommonMark and GitHub renders it as a hard
 * line break. It is modelled two ways (data-parse/hardBreak.ts):
 *
 *   - running text (paragraph, heading, list item): an atomic group — a
 *     hidden MdSymbol carrying the exact source and a HardBreak leaf that
 *     renders the <br>. The Markdown round-trip is byte-exact.
 *   - table cell: a "\n" in the model — the same character a paragraph soft
 *     break is, so all editing machinery applies — and `<br>` in markdown.
 *     The conversion happens at the table boundary; an edit inside a cell
 *     reparses the cell as inline content, never as a document.
 *
 * Contract asserted here:
 *   1. running text: one HardBreak node (not the EmptyP placeholder Br),
 *      every spelling round-trips byte-exact, nesting and leading `<br>`;
 *   2. non-regressions: autolink, code fence, `<br class>` stay as before;
 *   3. table cells: `<br>` ⇔ "\n" both ways, canonical fixed point, column
 *      padding measured on the written text, spellings normalize, code
 *      spans and escapes keep a literal `<br>`, nested constructs;
 *   4. cursor offsets reported by a cell parse are model offsets, and the
 *      md-offset APIs (setSelection / getSelectionOffsets) agree;
 *   5. edits through the real EditorStore: a typed / pasted / replaced line
 *      break in a cell is written `<br>`, the cell reparse stays one inline
 *      paragraph, undo restores the text;
 *   6. plain-text copy: a hard break is a line break, the cursor right after
 *      it is the start of the next line, multi-line cells are TSV-quoted
 *      unless an endpoint sits inside them;
 *   7. rich backspace right after a running-text `<br>` deletes it whole.
 *
 * The DOM half (caret placement after a break) needs a real browser:
 * scripts/verify-inline-br/caret.sh.
 */
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import { toPlainText } from "../../src/editor/model/serialize/toPlainText";
import { planRichBackspace } from "../../src/editor/model/rich/planRichBackspace";
import { EditorStore } from "../../src/editor/store";
import { CursorMarker } from "../../src/editor/constant";
import { DATA_HARD_BREAK } from "../../src/data-parse/constant";
import { MarkdownType } from "../../src/editor/type/enum";
import { CursorInfo, ParentRenderData, RenderData } from "../../src/editor/type";

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
const M = CursorMarker;

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

/** A block's model text: the concat of its leaves (what the DOM carries). */
const modelText = (node: AnyNode): string => {
    const children = (node as ParentRenderData).children_;
    if (children) return children.map(modelText).join("");
    return node.text_ ?? "";
};

const roundTrip = (md: string) => toMarkdown(parseMarkdown(md));
const brNodes = (md: string) => findAll(parseMarkdown(md), MarkdownType.HardBreak);

/** The paragraph inside every body cell, in document order. */
const bodyCells = (node: AnyNode): ParentRenderData[] =>
    findAll(node, MarkdownType.TD).map(
        (cell) => (cell as ParentRenderData).children_[0] as ParentRenderData,
    );

const table = (...rows: string[]) =>
    ["| h1 | h2 |", "| --- | --- |", ...rows].join("\n");

/** Same slicing rule as EditorController.serializeSelection_. */
const cut = (text: string) => {
    const first = text.indexOf(M);
    const last = text.lastIndexOf(M);
    if (first === -1) return null;
    return first === last ? text.slice(0, first) : text.slice(first + M.length, last);
};

// ---------------------------------------------------------------------------
// 1. Running text
// ---------------------------------------------------------------------------
{
    const md = "第一行<br>第二行";
    const tree = parseMarkdown(md);
    const breaks = brNodes(md);
    check("paragraph: one HardBreak node", breaks.length === 1, { count: breaks.length });
    check("paragraph: no EmptyP placeholder Br", findAll(tree, MarkdownType.Br).length === 0);
    check(
        "paragraph: HardBreak carries the DOM marker",
        breaks[0]?.htmlProps_?.[DATA_HARD_BREAK] === "true",
        breaks[0]?.htmlProps_,
    );
    check("paragraph: visible text drops the tag", visibleText(tree) === "第一行第二行", visibleText(tree));
    check("paragraph: byte-exact round-trip", roundTrip(md) === md, roundTrip(md));
}
for (const tag of ["<br/>", "<br />", "<BR>", "<Br/>"]) {
    const md = `前${tag}后`;
    check(`spelling ${tag}: one HardBreak node`, brNodes(md).length === 1);
    check(`spelling ${tag}: byte-exact round-trip`, roundTrip(md) === md, roundTrip(md));
}
{
    const md = "<u>a<br>b</u>";
    const tree = parseMarkdown(md);
    check("nested in <u>: HardBreak exists", findAll(tree, MarkdownType.HardBreak).length === 1);
    check("nested in <u>: visible text", visibleText(tree) === "ab", visibleText(tree));
    check("nested in <u>: round-trip", roundTrip(md) === md, roundTrip(md));
}
{
    const md = "<br>继续";
    const tree = parseMarkdown(md);
    const topLevel = (tree.children_ || []).map((child) => String(child.htmlType_));
    check("leading <br>: paragraph, not HTML block", !topLevel.includes(String(MarkdownType.HTML)), topLevel);
    check("leading <br>: one HardBreak node", findAll(tree, MarkdownType.HardBreak).length === 1);
    check("leading <br>: round-trip", roundTrip(md) === md, roundTrip(md));
}

// ---------------------------------------------------------------------------
// 2. Non-regressions
// ---------------------------------------------------------------------------
{
    const autolink = "<https://example.com>";
    const tree = parseMarkdown(autolink);
    check("autolink still a Link", findAll(tree, MarkdownType.Link).length === 1);
    check("autolink has no HardBreak", findAll(tree, MarkdownType.HardBreak).length === 0);
    check("autolink round-trip", roundTrip(autolink) === autolink, roundTrip(autolink));
}
{
    const fence = "```\n<br>\n```";
    check("code fence: no HardBreak node", brNodes(fence).length === 0);
    check("code fence: round-trip", roundTrip(fence) === fence, roundTrip(fence));
}
{
    const md = '前<br class="x">后';
    check("attrs stay literal", brNodes(md).length === 0);
    check("attrs round-trip", roundTrip(md) === md, roundTrip(md));
}

// ---------------------------------------------------------------------------
// 3. Table cells: `<br>` in markdown, "\n" in the model
// ---------------------------------------------------------------------------
{
    const md = [
        "| 账号 | 5 小时滚动 | 状态 |",
        "| ---- | ---------------------- | -- |",
        "| 账号1 | 4%<br>重置 11-02 18:18 | 健康 |",
        "| 账号2 | 12%<br>重置 11-02 18:18 | 健康 |",
    ].join("\n");
    const tree = parseMarkdown(md);
    check("table: no HardBreak node inside cells", findAll(tree, MarkdownType.HardBreak).length === 0);
    const percent = bodyCells(tree).find((p) => modelText(p).startsWith("4%"));
    check(
        "table: cell model text holds a \\n",
        percent !== undefined && modelText(percent) === "4%\n重置 11-02 18:18",
        percent && modelText(percent),
    );
    check(
        "table: the break joins the cell's text into one leaf",
        percent !== undefined && percent.children_.length === 1,
        percent?.children_.length,
    );
    const serialized = toMarkdown(tree);
    check("table: serializer writes <br>", serialized.includes("| 4%<br>重置 11-02 18:18 "), serialized);
    check("table: no raw newline inside a row", serialized.split("\n").length === 4, serialized);
    const widths = new Set(serialized.split("\n").map((line) => line.length));
    check("table: padding measured on the written text", widths.size === 1, serialized);
    check("table: canonical fixed point", roundTrip(serialized) === serialized, roundTrip(serialized));
}
{
    const md = table("| a<br/>b | c<BR>d<br />e |");
    const once = roundTrip(md);
    check("cell spellings normalize to <br>", once.includes("a<br>b") && once.includes("c<br>d<br>e"), once);
    check("cell spellings: then a fixed point", roundTrip(once) === once, roundTrip(once));
}
{
    const md = table("| `a<br>b` | x |");
    const tree = parseMarkdown(md);
    const code = findAll(tree, MarkdownType.Code)[0];
    check("cell code span keeps a literal <br>", code?.text_ === "a<br>b", code?.text_);
    check("cell code span: round-trip", roundTrip(roundTrip(md)) === roundTrip(md));
    check("cell code span: still <br> in markdown", roundTrip(md).includes("`a<br>b`"), roundTrip(md));
}
{
    const md = table("| a\\<br>b | x |");
    const cell = bodyCells(parseMarkdown(md))[0];
    check("cell escape keeps a literal <br>", !modelText(cell).includes("\n"), modelText(cell));
    check("cell escape: round-trip", roundTrip(md).includes("a\\<br>b"), roundTrip(md));
}
{
    const md = table("| **a<br>b** | [c<br>d](https://x.y) |");
    const tree = parseMarkdown(md);
    const [bold, link] = bodyCells(tree);
    check("cell bold: break inside the construct", visibleText(bold) === "a\nb", visibleText(bold));
    check(
        "cell bold: lowered leaf keeps the construct's symbols",
        findAll(bold, MarkdownType.Plain).some(
            (n) => n.text_ === "a\nb" && n.mdSymbols_.length === 2,
        ),
    );
    check("cell link: break inside link text", visibleText(link) === "c\nd", visibleText(link));
    check(
        "cell bold + link: round-trip",
        roundTrip(md).includes("**a<br>b**") && roundTrip(md).includes("[c<br>d](https://x.y)"),
        roundTrip(md),
    );
}
{
    const md = table("| <br> | a<br> |");
    const [only, tail] = bodyCells(parseMarkdown(md));
    check("cell holding only <br> is a \\n", modelText(only) === "\n", modelText(only));
    check("cell ending in <br> ends in \\n", modelText(tail) === "a\n", modelText(tail));
    check("cell edge breaks: round-trip", roundTrip(roundTrip(md)) === roundTrip(md));
}
{
    const tree = parseMarkdown("# h<br>x\n\n- li<br>y");
    check("heading and list item keep HardBreak groups", findAll(tree, MarkdownType.HardBreak).length === 2);
}

// ---------------------------------------------------------------------------
// 4. Cursor offsets are model offsets
// ---------------------------------------------------------------------------
const cellCursor = (cellText: string): number | null => {
    let found: number | null = null;
    parseMarkdown(table(`| ${cellText} | x |`), {
        onCursorFound_: (ci: CursorInfo) => {
            found = ci.offset;
        },
    });
    return found;
};
check("cursor after <br> in a cell", cellCursor(`a<br>${M}b`) === 2, cellCursor(`a<br>${M}b`));
check("cursor before <br> in a cell", cellCursor(`a${M}<br>b`) === 1, cellCursor(`a${M}<br>b`));
check("cursor inside the tag lands after the break", cellCursor(`a<b${M}r>b`) === 2, cellCursor(`a<b${M}r>b`));
check("cursor after two breaks", cellCursor(`a<br>b<br/>${M}c`) === 4, cellCursor(`a<br>b<br/>${M}c`));
{
    const doc = ["intro", "", table("| a<br>b | x |")].join("\n");
    const store = new EditorStore({ initMd: doc, editable: true });
    const md = store.toMarkdown();
    const target = md.indexOf("a<br>b") + "a<br>".length;
    const result = store.setSelection({ start: target });
    const cell = bodyCells(store.renderData_)[0];
    check("setSelection after <br> in a cell: applied", result.applied === true, result);
    check(
        "setSelection after <br> in a cell: model offset",
        store.startCursorInfo?.uuid === cell.uuid_ && store.startCursorInfo?.offset === 2,
        store.startCursorInfo,
    );
    const offsets = store.getSelectionOffsets();
    check("getSelectionOffsets echoes the md offset", offsets?.start === target, { offsets, target });
    // ⌘F highlights: a markdown match across the cell break resolves to the
    // model range over "a\nb".
    const matchStart = md.indexOf("a<br>b");
    const [range] = store.resolveRanges({ start: matchStart, end: matchStart + "a<br>b".length });
    check(
        "resolveRanges across a cell break: model range",
        range?.start.uuid === cell.uuid_ && range.start.offset === 0 && range.end.offset === 3,
        range,
    );
}

// ---------------------------------------------------------------------------
// 5. Edits through the real EditorStore
// ---------------------------------------------------------------------------
const cellStore = (row: string) =>
    new EditorStore({ initMd: ["intro", "", table(row)].join("\n"), editable: true });
const rowCount = (store: EditorStore) =>
    store.toMarkdown().split("\n").filter((line) => line.startsWith("|")).length;
{
    const store = cellStore("| ab | x |");
    const before = store.toMarkdown();
    const cell = bodyCells(store.renderData_)[0];
    store.insertText("\n", { uuid: cell.uuid_, offset: 1 });
    const after = store.toMarkdown();
    const edited = bodyCells(store.renderData_)[0];
    check("typed break in a cell: written <br>", after.includes("| a<br>b |"), after);
    check("typed break in a cell: table intact", rowCount(store) === 3, after);
    check("typed break in a cell: model holds \\n", modelText(edited) === "a\nb", modelText(edited));
    check(
        "typed break in a cell: caret after the break",
        store.startCursorInfo?.uuid === edited.uuid_ && store.startCursorInfo?.offset === 2,
        store.startCursorInfo,
    );
    store.undo();
    check("typed break in a cell: undo restores", store.toMarkdown() === before, store.toMarkdown());
}
{
    const store = cellStore("| ab | x |");
    const cell = bodyCells(store.renderData_)[0];
    store.insertText("x\ny", { uuid: cell.uuid_, offset: 2 });
    check("pasted lines in a cell: <br>", store.toMarkdown().includes("| abx<br>y |"), store.toMarkdown());
    check("pasted lines in a cell: table intact", rowCount(store) === 3, store.toMarkdown());
}
{
    const store = cellStore("| abcd | x |");
    const md = store.toMarkdown();
    const start = md.indexOf("abcd") + 1;
    store.setSelection({ start, end: start + 2 });
    store.insertText("p\nq");
    check("selection replaced in a cell: <br>", store.toMarkdown().includes("| ap<br>qd |"), store.toMarkdown());
    check("selection replaced in a cell: table intact", rowCount(store) === 3, store.toMarkdown());
}
const resetCell = (store: EditorStore, text: string) => {
    const cell = bodyCells(store.renderData_)[0];
    store.chainProduceParsedData_((chain) => {
        chain.resetTextByUUID_(cell.uuid_, text);
    });
    const td = findAll(store.renderData_, MarkdownType.TD)[0] as ParentRenderData;
    return { td, cell: td.children_[0] as ParentRenderData };
};
{
    const store = cellStore("| a | x |");
    const { td, cell } = resetCell(store, `- x${M}`);
    check("cell reparse: '- x' stays one paragraph", td.children_.length === 1 && cell.htmlType_ === MarkdownType.P, td.children_.map((c) => c.htmlType_));
    check("cell reparse: no list inside the cell", findAll(td, MarkdownType.Ul).length === 0);
    check("cell reparse: '- x' serializes as text", store.toMarkdown().includes("| - x |"), store.toMarkdown());
}
{
    const store = cellStore("| a | x |");
    const { td, cell } = resetCell(store, `# t${M}`);
    check("cell reparse: '# t' stays a paragraph", td.children_.length === 1 && cell.htmlType_ === MarkdownType.P, td.children_.map((c) => c.htmlType_));
}
{
    const store = cellStore("| a | x |");
    const { td, cell } = resetCell(store, `a\n\nb${M}`);
    check("cell reparse: blank line stays in one paragraph", td.children_.length === 1, td.children_.map((c) => c.htmlType_));
    check("cell reparse: blank line kept as text", modelText(cell) === "a\n\nb", modelText(cell));
    check("cell reparse: blank line written <br><br>", store.toMarkdown().includes("| a<br><br>b |"), store.toMarkdown());
    check("cell reparse: caret mapped to model", store.startCursorInfo?.offset === 4, store.startCursorInfo);
}
{
    const store = cellStore("| a | x |");
    const { cell } = resetCell(store, `a<br>${M}b`);
    check("typed <br> in a cell becomes \\n", modelText(cell) === "a\nb", modelText(cell));
    check("typed <br> in a cell: caret after the break", store.startCursorInfo?.offset === 2, store.startCursorInfo);
}
{
    const store = cellStore("| a<br>b | x |");
    resetCell(store, `a${M}b`);
    check("deleting the \\n joins the cell", store.toMarkdown().includes("| ab |"), store.toMarkdown());
}

// ---------------------------------------------------------------------------
// 6. Plain-text copy
// ---------------------------------------------------------------------------
{
    const tree = parseMarkdown("第一行<br>第二行");
    const p = tree.children_[0] as ParentRenderData;
    check("plain text: a hard break is a line break", toPlainText(tree) === "第一行\n第二行", toPlainText(tree));
    const end = modelText(p).length;
    const fromAfter = cut(toPlainText(tree, [{ uuid: p.uuid_, offset: 7 }, { uuid: p.uuid_, offset: end }]));
    check("plain text: selection from the start of line 2", fromAfter === "第二行", fromAfter);
    const fromBefore = cut(toPlainText(tree, [{ uuid: p.uuid_, offset: 3 }, { uuid: p.uuid_, offset: end }]));
    check("plain text: selection from the end of line 1", fromBefore === "\n第二行", fromBefore);
}
{
    const tree = parseMarkdown(table('| 4%<br>重置 | ok |', '| say "hi"<br>bye | z |'));
    const text = toPlainText(tree);
    check(
        "plain text: multi-line cells are TSV-quoted",
        text === 'h1\th2\n"4%\n重置"\tok\n"say ""hi""\nbye"\tz',
        text,
    );
    const cell = bodyCells(tree)[0];
    const inside = cut(toPlainText(tree, [{ uuid: cell.uuid_, offset: 0 }, { uuid: cell.uuid_, offset: 4 }]));
    check("plain text: selection inside a multi-line cell is raw", inside === "4%\n重", inside);
}

// ---------------------------------------------------------------------------
// 7. Rich backspace right after a running-text <br>
// ---------------------------------------------------------------------------
{
    const tree = parseMarkdown("第一行<br>第二行");
    const p = tree.children_[0] as ParentRenderData;
    const plan = planRichBackspace(p, modelText(p), 7);
    check(
        "rich backspace after <br> deletes it whole",
        plan.kind_ === "text" && plan.text_ === `第一行${M}第二行`,
        plan,
    );
}

rawLog(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
