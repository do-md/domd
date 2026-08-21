/**
 * GFM table immediately after a paragraph line (no blank line) — issue #18.
 *
 * GitHub/cmark-gfm parse a pipe table that follows a paragraph (or a bold
 * paragraph) as <p>…</p> + <table>. DOMD used to swallow those table lines
 * into the paragraph because parseP never broke on a pipe-started table.
 *
 * Heading and blank-line already work. List-item tables currently parse as
 * tables (more permissive than GFM); this matrix only locks that, it does
 * not change it.
 *
 * Run: sh scripts/verify-table-after-paragraph/run.sh
 */
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { MarkdownType } from "../../src/editor/type/enum";
import { ParentRenderData, RenderData } from "../../src/editor/type";

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
        rawLog(`✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
    }
};

type AnyNode = ParentRenderData | RenderData;

const findAll = (node: AnyNode, type: string): AnyNode[] => {
    const out: AnyNode[] = [];
    const walk = (n: AnyNode) => {
        if (n.htmlType_ === (type as AnyNode["htmlType_"])) out.push(n);
        n.children_?.forEach(walk);
    };
    walk(node);
    return out;
};

const textOf = (node: AnyNode): string => {
    if (node.children_?.length) return node.children_.map(textOf).join("");
    return node.text_ ?? "";
};

const TABLE = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");

const cellTexts = (table: AnyNode): string[] =>
    [...findAll(table, MarkdownType.TH), ...findAll(table, MarkdownType.TD)].map(
        (cell) => textOf(cell).trim(),
    );

const topTypes = (tree: AnyNode): string[] =>
    (tree.children_ || []).map((c) => String(c.htmlType_));

const assertTableAfter = (
    name: string,
    md: string,
    leadType: MarkdownType,
) => {
    const tree = parseMarkdown(md);
    const tables = findAll(tree, MarkdownType.Table);
    check(`${name}: one table node`, tables.length === 1, {
        count: tables.length,
        types: topTypes(tree),
    });
    if (tables.length !== 1) return;

    const top = tree.children_ || [];
    const tableIndex = top.findIndex(
        (c) => c.htmlType_ === MarkdownType.Table,
    );
    check(`${name}: table is a top-level sibling`, tableIndex >= 0, {
        types: topTypes(tree),
    });
    check(
        `${name}: ${leadType} precedes the table`,
        tableIndex > 0 &&
            top.slice(0, tableIndex).some((c) => c.htmlType_ === leadType),
        { types: topTypes(tree) },
    );
    check(
        `${name}: cells`,
        JSON.stringify(cellTexts(tables[0])) === JSON.stringify(["a", "b", "1", "2"]),
        cellTexts(tables[0]),
    );
};

// ---------------------------------------------------------------------------
// Named failures from issue #18 — must go RED on unpatched parseP.
// ---------------------------------------------------------------------------
assertTableAfter(
    "(1) paragraph line then table",
    ["Some text", TABLE].join("\n"),
    MarkdownType.P,
);
assertTableAfter(
    "(2) bold paragraph line then table",
    ["**Lead-in:**", TABLE].join("\n"),
    MarkdownType.P,
);

// ---------------------------------------------------------------------------
// Already-working controls from issue #18.
// ---------------------------------------------------------------------------
assertTableAfter(
    "heading then table",
    ["# Heading", TABLE].join("\n"),
    MarkdownType.H1,
);
assertTableAfter(
    "blank line then table",
    ["Some text", "", TABLE].join("\n"),
    MarkdownType.P,
);

// ---------------------------------------------------------------------------
// List-item tables currently parse as tables (DOMD is more permissive than
// GFM here). Lock current behavior; do not "fix" this toward cmark-gfm.
// ---------------------------------------------------------------------------
assertTableAfter(
    "list item then table (lock current)",
    ["- item", TABLE].join("\n"),
    MarkdownType.Ul,
);

rawLog(`\ntable-after-paragraph: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
