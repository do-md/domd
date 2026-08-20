/**
 * Headless assertion matrix for the structural table ops
 * (EditorStore.addTableRow / addTableColumn).
 * Run: sh scripts/verify-table-ops/run.sh
 *
 * Instantiates the REAL EditorStore (no DOM on these paths) and asserts:
 *   1. TEXT — resulting markdown has the expected rows/columns, padding
 *      renormalized (canonicalized-splice contract).
 *   2. CANONICALITY — result round-trips: parse(toMarkdown(tree)) serializes
 *      to the same text (no drift a fresh parse would "correct").
 *   3. IDENTITY — top-level blocks OUTSIDE the table keep reference
 *      equality (table itself renews wholesale — same baseline as typing in
 *      a cell; mergeParsedBlock does not cover Table yet).
 *   4. CURSOR — caret lands inside the new row's first cell / new column's
 *      header cell (uuid resolves inside the table subtree).
 *   5. FAILURE — bad uuid / out-of-range index → false, zero state change,
 *      no history entry.
 *   6. UNDO — one op = one undo step back to the pristine text.
 */
import { EditorStore } from "../../src/editor/store";
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { splitTextSpans } from "../../src/data-parse/postprocess/splitTextSpans";
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
        rawLog(`✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
    }
};

type AnyNode = ParentRenderData | RenderData;

const makeStore = (initMd: string) =>
    new EditorStore({ editable: true, initMd });

const TABLE_DOC = [
    "# title",
    "",
    "| h1 | h2 |",
    "| --- | --- |",
    "| a | b |",
    "| c | d |",
    "",
    "tail paragraph",
].join("\n");

const findTable = (store: EditorStore): ParentRenderData => {
    const t = store.renderData_.children_.find(
        (c: AnyNode) => c.htmlType_ === MarkdownType.Table,
    );
    if (!t) throw new Error("no table in doc");
    return t as ParentRenderData;
};

const tableLines = (store: EditorStore): string[] => {
    const md = toMarkdown(findTable(store)) || "";
    return md.split("\n");
};

const subtreeHasUuid = (node: AnyNode, uuid: string): boolean => {
    if (node.uuid_ === uuid) return true;
    return (node.children_ || []).some((c: AnyNode) =>
        subtreeHasUuid(c, uuid),
    );
};

/** Round-trip canonicality: reparse of the serialization serializes back
 *  to the same text. */
const roundTrips = (store: EditorStore): boolean => {
    const md = store.toMarkdown();
    const reparsed = parseMarkdown(md);
    splitTextSpans(reparsed);
    return (toMarkdown(reparsed) || "") === md;
};

// ---------------------------------------------------------------------------
// 1. addTableRow — append (default index)
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const table = findTable(store);
    const othersBefore = store.renderData_.children_.filter(
        (c: AnyNode) => c.htmlType_ !== MarkdownType.Table,
    );
    const ok = store.addTableRow(table.uuid_);
    check("row/append: returns true", ok);
    const lines = tableLines(store);
    check("row/append: one more line", lines.length === 5, lines);
    check(
        "row/append: new last row is empty cells",
        /^\|\s+\|\s+\|$/.test(lines[4]),
        lines[4],
    );
    check(
        "row/append: existing rows intact",
        lines[2].includes("a") && lines[3].includes("c"),
    );
    check("row/append: round-trips", roundTrips(store));
    const othersAfter = store.renderData_.children_.filter(
        (c: AnyNode) => c.htmlType_ !== MarkdownType.Table,
    );
    check(
        "row/append: blocks outside table keep reference identity",
        othersBefore.length === othersAfter.length &&
            othersBefore.every((n: AnyNode, i: number) => n === othersAfter[i]),
    );
    const cursor = store.startCursorInfo;
    check(
        "row/append: cursor lands inside the (new) table subtree",
        !!cursor && subtreeHasUuid(findTable(store), cursor.uuid),
        cursor,
    );
    // Cursor cell precision: uuid should live in the LAST body row.
    const body = findTable(store).children_?.[1];
    const lastRow = body?.children_?.at(-1);
    check(
        "row/append: cursor in the new (last) row's subtree",
        !!cursor && !!lastRow && subtreeHasUuid(lastRow, cursor.uuid),
    );
}

// ---------------------------------------------------------------------------
// 2. addTableRow — index 0 (right below header), addressed by INNER uuid
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    // Address the table via a deep inner uuid (first TH's first leaf).
    const table = findTable(store);
    let innerUuid = table.uuid_;
    let probe: AnyNode | undefined =
        table.children_?.[0]?.children_?.[0]?.children_?.[0];
    while (probe) {
        innerUuid = probe.uuid_;
        probe = probe.children_?.[0];
    }
    check("row/at0: inner uuid differs from table uuid", innerUuid !== table.uuid_);
    const ok = store.addTableRow(innerUuid, 0);
    check("row/at0: returns true (resolved via containing table)", ok);
    const lines = tableLines(store);
    check(
        "row/at0: new empty row directly after separator",
        /^\|\s+\|\s+\|$/.test(lines[2]) && lines[3].includes("a"),
        lines,
    );
    check("row/at0: round-trips", roundTrips(store));
}

// ---------------------------------------------------------------------------
// 3. addTableColumn — append (default index)
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const ok = store.addTableColumn(findTable(store).uuid_);
    check("col/append: returns true", ok);
    const table = findTable(store);
    const headerCells =
        table.children_?.[0]?.children_?.[0]?.children_?.length || 0;
    check("col/append: header now 3 columns", headerCells === 3);
    const bodyRows = table.children_?.[1]?.children_ || [];
    check(
        "col/append: every body row now 3 cells",
        bodyRows.every((tr: AnyNode) => (tr.children_?.length || 0) === 3),
    );
    const lines = tableLines(store);
    // Separator is DERIVED at serialize time ("-".repeat(column width)) —
    // an all-empty column has width 0, so its separator cell is dash-less.
    // Assert cell count, not dash groups.
    check(
        "col/append: separator gained a third cell",
        lines[1].split("|").length - 2 === 3,
        lines[1],
    );
    check("col/append: round-trips", roundTrips(store));
    const cursor = store.startCursorInfo;
    const headerTr = table.children_?.[0]?.children_?.[0];
    const newTh = headerTr?.children_?.at(-1);
    check(
        "col/append: cursor in the new header cell's subtree",
        !!cursor && !!newTh && subtreeHasUuid(newTh, cursor.uuid),
        cursor,
    );
}

// ---------------------------------------------------------------------------
// 4. addTableColumn — index 0 (left edge); existing content shifts right
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const ok = store.addTableColumn(findTable(store).uuid_, 0);
    check("col/at0: returns true", ok);
    const table = findTable(store);
    const headerTr = table.children_?.[0]?.children_?.[0];
    const firstThText = toMarkdown(headerTr!.children_![1]) || "";
    check(
        "col/at0: old first header cell shifted to position 1",
        firstThText.includes("h1"),
        firstThText,
    );
    const lines = tableLines(store);
    check(
        "col/at0: rows keep their content",
        lines[2].includes("a") && lines[3].includes("c"),
    );
    check("col/at0: round-trips", roundTrips(store));
}

// ---------------------------------------------------------------------------
// 5. Failure paths — false, zero state change, no history entry
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const before = store.toMarkdown();
    check("fail: unknown uuid → false", store.addTableRow("nope1234") === false);
    check(
        "fail: non-table uuid → false",
        store.addTableRow(store.renderData_.children_[0].uuid_) === false,
    );
    check(
        "fail: row index out of range → false",
        store.addTableRow(findTable(store).uuid_, 3) === false &&
            store.addTableRow(findTable(store).uuid_, -1) === false,
    );
    check(
        "fail: col index out of range → false",
        store.addTableColumn(findTable(store).uuid_, 5) === false,
    );
    check("fail: document untouched", store.toMarkdown() === before);
    const undone = store.undo();
    check(
        "fail: no history entry (undo is a no-op)",
        store.toMarkdown() === before,
        undone,
    );
}

// ---------------------------------------------------------------------------
// 6. Undo — one op = one step back to pristine
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const before = store.toMarkdown();
    store.addTableRow(findTable(store).uuid_);
    const after = store.toMarkdown();
    check("undo: op changed the doc", after !== before);
    store.undo();
    check("undo: one step restores pristine text", store.toMarkdown() === before);
    store.redo();
    check("undo: redo restores the op", store.toMarkdown() === after);
}

// ---------------------------------------------------------------------------
// 7. Single-column table + consecutive ops compose
// ---------------------------------------------------------------------------
{
    const store = makeStore("| only |\n| --- |\n| x |");
    const t = findTable(store);
    check("compose: row on 1-col table", store.addTableRow(t.uuid_));
    check("compose: col after row", store.addTableColumn(findTable(store).uuid_));
    const table = findTable(store);
    const headerCells =
        table.children_?.[0]?.children_?.[0]?.children_?.length || 0;
    const bodyRows = table.children_?.[1]?.children_ || [];
    check(
        "compose: 2 cols × 2 body rows (1 original + 1 added)",
        headerCells === 2 && bodyRows.length === 2,
        { headerCells, rows: bodyRows.length },
    );
    check("compose: round-trips", roundTrips(store));
}

// ---------------------------------------------------------------------------
// 8. MERGE IDENTITY — addTableRow keeps table/THead/untouched-row references
//    (the collaborative-attribution requirement: only the new row is new)
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    const tableUuid = t0.uuid_;
    const thead0 = t0.children_![0];
    const tbody0 = t0.children_![1];
    const rows0 = [...tbody0.children_!];
    store.addTableRow(tableUuid, 1); // insert between the two body rows
    const t1 = findTable(store);
    // Ancestors on the changed path are immer-copied (new object, SAME uuid);
    // untouched sibling subtrees keep reference equality.
    check("merge/row: table uuid preserved", t1.uuid_ === tableUuid);
    check("merge/row: THead reference preserved", t1.children_![0] === thead0);
    check(
        "merge/row: TBody uuid preserved",
        t1.children_![1].uuid_ === tbody0.uuid_,
    );
    const rows1 = t1.children_![1].children_!;
    check("merge/row: 3 body rows", rows1.length === 3);
    check(
        "merge/row: untouched rows keep reference identity",
        rows1[0] === rows0[0] && rows1[2] === rows0[1],
    );
    check(
        "merge/row: inserted row is fresh",
        rows1[1] !== rows0[0] && rows1[1] !== rows0[1],
    );
    const cursor = store.startCursorInfo;
    check(
        "merge/row: cursor lands in the inserted row",
        !!cursor && subtreeHasUuid(rows1[1], cursor.uuid),
    );
}

// ---------------------------------------------------------------------------
// 9. MERGE IDENTITY — addTableColumn keeps rows and untouched cells
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    const headerTr0 = t0.children_![0].children_![0];
    const headerCells0 = [...headerTr0.children_!];
    const rows0 = t0.children_![1].children_!.map((tr) => ({
        tr,
        cells: [...tr.children_!],
    }));
    store.addTableColumn(t0.uuid_, 1); // insert between h1 and h2
    const t1 = findTable(store);
    check("merge/col: table uuid preserved", t1.uuid_ === t0.uuid_);
    const headerTr1 = t1.children_![0].children_![0];
    // Every row gains a cell → every TR is on the changed path (uuid kept);
    // the untouched CELLS inside keep reference equality.
    check("merge/col: header TR uuid preserved", headerTr1.uuid_ === headerTr0.uuid_);
    check(
        "merge/col: untouched header cells keep references",
        headerTr1.children_![0] === headerCells0[0] &&
            headerTr1.children_![2] === headerCells0[1],
    );
    check(
        "merge/col: inserted header cell is fresh",
        headerTr1.children_![1] !== headerCells0[0] &&
            headerTr1.children_![1] !== headerCells0[1],
    );
    const rows1 = t1.children_![1].children_!;
    check(
        "merge/col: body TR uuids preserved",
        rows1[0].uuid_ === rows0[0].tr.uuid_ &&
            rows1[1].uuid_ === rows0[1].tr.uuid_,
    );
    check(
        "merge/col: untouched body cells keep references",
        rows1[0].children_![0] === rows0[0].cells[0] &&
            rows1[0].children_![2] === rows0[0].cells[1] &&
            rows1[1].children_![0] === rows0[1].cells[0] &&
            rows1[1].children_![2] === rows0[1].cells[1],
    );
}

// ---------------------------------------------------------------------------
// 10. MERGE IDENTITY — cell text edit (replaceText → scoped reparse) keeps
//     the table, all rows, and even the edited cell's inner P identity
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    const rows0 = t0.children_![1].children_!.map((tr) => ({
        tr,
        cells: [...tr.children_!],
    }));
    const editedCellP0 = rows0[0].cells[0].children_![0]; // TD > P
    const result = store.replaceText({ search: "| a ", replace: "| aX " });
    check(
        "merge/edit: replaceText applied",
        result.applied === 1 || (result as any).applied === undefined,
        result,
    );
    check("merge/edit: text updated", store.toMarkdown().includes("aX"));
    const t1 = findTable(store);
    check("merge/edit: table uuid preserved", t1.uuid_ === t0.uuid_);
    const rows1 = t1.children_![1].children_!;
    check(
        "merge/edit: untouched TR keeps reference identity",
        rows1[1] === rows0[1].tr,
    );
    check(
        "merge/edit: edited TR uuid preserved",
        rows1[0].uuid_ === rows0[0].tr.uuid_,
    );
    check(
        "merge/edit: untouched sibling cell keeps reference",
        rows1[0].children_![1] === rows0[0].cells[1],
    );
    check(
        "merge/edit: edited cell TD uuid preserved",
        rows1[0].children_![0].uuid_ === rows0[0].cells[0].uuid_,
    );
    check(
        "merge/edit: edited cell inner P uuid preserved (span-level merge)",
        rows1[0].children_![0].children_![0].uuid_ === editedCellP0.uuid_,
    );
}

// ---------------------------------------------------------------------------
// 11. MERGE IDENTITY — code block edit keeps Pre, fences and PreCode
// ---------------------------------------------------------------------------
{
    const store = makeStore(
        ["intro", "", "```js", "const a = 1;", "const b = 9;", "```", "", "outro"].join(
            "\n",
        ),
    );
    const pre0 = store.renderData_.children_.find(
        (c: AnyNode) => c.htmlType_ === MarkdownType.Pre,
    ) as ParentRenderData;
    check("merge/code: doc has a Pre block", !!pre0);
    // Pre children: [MdHideSymbol(fence), HideSecondLine, PreCode,
    // HideSecondLine, MdHideSymbol(fence)] — locate PreCode by type.
    const fenceOpen0 = pre0.children_![0];
    const fenceClose0 = pre0.children_!.at(-1)!;
    const preCode0 = pre0.children_!.find(
        (c) => c.htmlType_ === MarkdownType.PreCode,
    )!;
    store.replaceText({ search: "const a = 1;", replace: "const a = 2;" });
    check(
        "merge/code: text updated",
        store.toMarkdown().includes("const a = 2;"),
    );
    const pre1 = store.renderData_.children_.find(
        (c: AnyNode) => c.htmlType_ === MarkdownType.Pre,
    ) as ParentRenderData;
    check("merge/code: Pre uuid preserved", pre1.uuid_ === pre0.uuid_);
    check(
        "merge/code: fence symbols keep references",
        pre1.children_![0] === fenceOpen0 &&
            pre1.children_!.at(-1) === fenceClose0,
    );
    check(
        "merge/code: PreCode container uuid preserved",
        pre1.children_!.find((c) => c.htmlType_ === MarkdownType.PreCode)!
            .uuid_ === preCode0.uuid_,
    );
    check("merge/code: round-trips", roundTrips(store));
}

// ---------------------------------------------------------------------------
// 12. OP STREAM — structural ops reach collaborators fine-grained (no
//     whole-table replacement op)
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const ops: unknown[] = [];
    const unsub = store.subscribeRenderDataOps((batch: unknown[]) =>
        ops.push(...batch),
    );
    store.addTableRow(findTable(store).uuid_);
    unsub();
    const json = JSON.stringify(ops);
    check("ops: some ops emitted", ops.length > 0);
    check(
        "ops: no whole-table node in the op stream",
        !json.includes('"type":"Table"'),
        json.slice(0, 300),
    );
    check(
        "ops: no replaceRoot",
        !ops.some((o: any) => o?.op === "replaceRoot"),
    );
    check("ops: the inserted TR travels as its own node", json.includes('"TR"'));
}

// ---------------------------------------------------------------------------
// 13. deleteTableRow — explicit index; caret remaps onto the KEPT next row
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    const rows0 = [...t0.children_![1].children_!];
    // P inside first cell of the SECOND row — the row that takes the slot.
    const survivorP0 = rows0[1].children_![0].children_![0];
    const ok = store.deleteTableRow(t0.uuid_, 0);
    check("del-row: returns true", ok);
    const lines = tableLines(store);
    check("del-row: one body row left", lines.length === 3, lines);
    check(
        "del-row: the right row was deleted",
        !store.toMarkdown().includes("| a") && lines[2].includes("c"),
    );
    const t1 = findTable(store);
    const rows1 = t1.children_![1].children_!;
    check(
        "del-row: surviving row keeps reference identity",
        rows1[0] === rows0[1],
    );
    const cursor = store.startCursorInfo;
    check(
        "del-row: caret remapped onto the KEPT row's first-cell P (uuid remap proof)",
        !!cursor &&
            cursor.uuid === survivorP0.uuid_ &&
            cursor.offset === 0,
        cursor,
    );
    check("del-row: round-trips", roundTrips(store));
    const before = store.toMarkdown();
    store.undo();
    check("del-row: undo restores", store.toMarkdown() !== before);
}

// ---------------------------------------------------------------------------
// 14. deleteTableRow — index inferred from a cell uuid; last-row deletion
//     leaves a legal header-only table
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    // uuid deep inside the SECOND body row → that row gets deleted.
    const row1CellP = t0.children_![1].children_![1].children_![0]
        .children_![0];
    check(
        "del-row/infer: returns true",
        store.deleteTableRow(row1CellP.uuid_),
    );
    check(
        "del-row/infer: the containing row was deleted",
        !store.toMarkdown().includes("| c") &&
            store.toMarkdown().includes("| a"),
    );
    // bare table uuid without index → cannot infer → false
    check(
        "del-row/infer: bare table uuid cannot infer",
        store.deleteTableRow(findTable(store).uuid_) === false,
    );
    // delete the last body row → header-only table still parses
    store.deleteTableRow(findTable(store).uuid_, 0);
    check(
        "del-row: header-only table survives",
        findTable(store).htmlType_ === MarkdownType.Table &&
            tableLines(store).length === 2,
        tableLines(store),
    );
    check("del-row: header-only round-trips", roundTrips(store));
}

// ---------------------------------------------------------------------------
// 15. deleteTableColumn — explicit index; untouched cells keep references
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    const headerTr0 = t0.children_![0].children_![0];
    const survivorTh0 = headerTr0.children_![1]; // h2 — takes the slot
    const rows0 = t0.children_![1].children_!.map((tr) => ({
        tr,
        cells: [...tr.children_!],
    }));
    const ok = store.deleteTableColumn(t0.uuid_, 0);
    check("del-col: returns true", ok);
    const md = store.toMarkdown();
    check(
        "del-col: first column gone",
        !md.includes("h1") && !md.includes("| a") && !md.includes("| c"),
        md,
    );
    check("del-col: second column kept", md.includes("h2") && md.includes("b"));
    const t1 = findTable(store);
    const headerTr1 = t1.children_![0].children_![0];
    check(
        "del-col: header TR uuid preserved",
        headerTr1.uuid_ === headerTr0.uuid_,
    );
    check(
        "del-col: surviving header cell keeps reference",
        headerTr1.children_![0] === survivorTh0,
    );
    const rows1 = t1.children_![1].children_!;
    check(
        "del-col: surviving body cells keep references",
        rows1[0].children_![0] === rows0[0].cells[1] &&
            rows1[1].children_![0] === rows0[1].cells[1],
    );
    const cursor = store.startCursorInfo;
    check(
        "del-col: caret remapped onto the KEPT header cell's P",
        !!cursor &&
            cursor.uuid === survivorTh0.children_![0].uuid_ &&
            cursor.offset === 0,
        cursor,
    );
    check("del-col: round-trips", roundTrips(store));
}

// ---------------------------------------------------------------------------
// 16. deleteTableColumn — inferred from cell uuid; last-column guard
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const t0 = findTable(store);
    // uuid inside the SECOND column of a body row → delete column 1.
    const bCellP = t0.children_![1].children_![0].children_![1].children_![0];
    check(
        "del-col/infer: returns true",
        store.deleteTableColumn(bCellP.uuid_),
    );
    const md = store.toMarkdown();
    check(
        "del-col/infer: second column gone",
        !md.includes("h2") && !md.includes("b |") && md.includes("h1"),
        md,
    );
    // now a single column — deleting it must be refused
    const before = store.toMarkdown();
    check(
        "del-col: last column refused",
        store.deleteTableColumn(findTable(store).uuid_, 0) === false,
    );
    check("del-col: refusal is a no-op", store.toMarkdown() === before);
}

// ---------------------------------------------------------------------------
// 17. delete failure paths — out of range / bad uuid → false, no side effects
// ---------------------------------------------------------------------------
{
    const store = makeStore(TABLE_DOC);
    const before = store.toMarkdown();
    const t = findTable(store);
    check(
        "del-fail: row out of range → false",
        store.deleteTableRow(t.uuid_, 2) === false &&
            store.deleteTableRow(t.uuid_, -1) === false,
    );
    check(
        "del-fail: col out of range → false",
        store.deleteTableColumn(t.uuid_, 2) === false,
    );
    check("del-fail: unknown uuid → false", store.deleteTableRow("nope") === false);
    check("del-fail: document untouched", store.toMarkdown() === before);
    store.undo();
    check("del-fail: no history entry", store.toMarkdown() === before);
}

// ---------------------------------------------------------------------------
// 18. SPAN-DIVERGENCE — a row whose span partition came from another client
//     (edit-history dependent, ≠ fresh parse) must survive addTableRow
//     untouched. THE reported collab-attribution repro: structural equality
//     would call this row "changed", dump it into the unequal-count splice
//     and renew every span; content equality must keep it.
// ---------------------------------------------------------------------------
{
    const store = makeStore(
        "| head1 | head2 |\n| --- | --- |\n| hello | world |",
    );
    // Simulate the remote-typed row: split the first cell's single text span
    // into two spans with the same concatenated text (span partitioning is
    // NOT canonical — it is exactly what a peer's typing history produces).
    (store as any).produce((draft: any) => {
        const table = draft.renderData_.children_.find(
            (c: any) => c.htmlType_ === MarkdownType.Table,
        );
        const cellP = table.children_[1].children_[0].children_[0]
            .children_[0];
        const leaf = cellP.children_[0];
        const mk = (text: string, uuid: string) => ({
            htmlType_: leaf.htmlType_,
            text_: text,
            uuid_: uuid,
            mdSymbols_: [],
            htmlProps_: {},
        });
        cellP.children_.splice(
            0,
            1,
            mk("hel", "remoteAA"),
            mk("lo", "remoteBB"),
        );
    });
    check(
        "divergent: perturbation kept the text",
        store.toMarkdown().includes("hello"),
    );
    const t0 = findTable(store);
    const row0 = t0.children_![1].children_![0];
    check("divergent: addTableRow ok", store.addTableRow(t0.uuid_));
    const t1 = findTable(store);
    const rows1 = t1.children_![1].children_!;
    check("divergent: 2 body rows", rows1.length === 2);
    check(
        "divergent: remote-typed row keeps REFERENCE identity",
        rows1[0] === row0,
    );
    const spans = rows1[0].children_![0].children_![0].children_!;
    check(
        "divergent: remote span partition intact (attribution preserved)",
        spans.length === 2 &&
            spans[0].uuid_ === "remoteAA" &&
            spans[1].uuid_ === "remoteBB",
        spans.map((s: AnyNode) => s.uuid_),
    );
    check("divergent: round-trips", roundTrips(store));

    // Same protection on delete: remove the NEW row again — the divergent
    // row must still be untouched.
    check(
        "divergent: deleteTableRow ok",
        store.deleteTableRow(findTable(store).uuid_, 1),
    );
    const rowsAfter = findTable(store).children_![1].children_!;
    check(
        "divergent: row survives the delete too",
        rowsAfter.length === 1 && rowsAfter[0].uuid_ === row0.uuid_,
    );
}

// ---------------------------------------------------------------------------
// 19. CODE DIRTY-DOM GUARD — the "const =" duplication repro. PreCode
//     children are the caret's direct text habitat (flat token spans): after
//     a merge the browser-dirtied span often sits in the KEPT region, so the
//     spans adjacent to the changed slot MUST get a domVersion bump (forced
//     remount flushes the speculative DOM write). Table family stays
//     bump-free (scenarios 8-10 assert reference identity — the gate).
// ---------------------------------------------------------------------------
{
    const tokenizer = (code: string): string[] =>
        code.match(/\s+|=+|[^\s=]+/g) || [];
    const store = new EditorStore({
        editable: true,
        initMd: "```js\nconst a = 1;\n```",
        codeTokenizer: tokenizer as any,
    });
    const findPreCode = (s: EditorStore) => {
        const pre = s.renderData_.children_.find(
            (c: AnyNode) => c.htmlType_ === MarkdownType.Pre,
        ) as ParentRenderData;
        return pre.children_!.find(
            (c) => c.htmlType_ === MarkdownType.PreCode,
        ) as ParentRenderData;
    };
    const preCode0 = findPreCode(store);
    const spans0 = [...preCode0.children_!];
    const editIdx = spans0.findIndex((sp) => sp.text_ === "a");
    check("dirty-lib: token span layout as expected", editIdx > 0, spans0.map((s) => s.text_));

    // One keystroke's worth of change through the same merge layer as typing.
    store.replaceText({ search: "const a =", replace: "const ab =" });
    check("dirty-lib: text updated", store.toMarkdown().includes("const ab ="));

    const preCode1 = findPreCode(store);
    check(
        "dirty-lib: PreCode uuid preserved (merge ran)",
        preCode1.uuid_ === preCode0.uuid_,
    );
    const spans1 = preCode1.children_!;
    check(
        "dirty-lib: edited token slot replaced (fresh uuid → remount)",
        spans1[editIdx].text_ === "ab" &&
            spans1[editIdx].uuid_ !== spans0[editIdx].uuid_,
    );
    check(
        "dirty-lib: KEPT neighbor spans bumped (uuid same, domVersion set)",
        spans1[editIdx - 1].uuid_ === spans0[editIdx - 1].uuid_ &&
            (spans1[editIdx - 1].domVersion_ || 0) === 1 &&
            spans1[editIdx + 1].uuid_ === spans0[editIdx + 1].uuid_ &&
            (spans1[editIdx + 1].domVersion_ || 0) === 1,
        spans1.map((s) => `${s.text_}@${s.domVersion_ ?? "-"}`),
    );
    check(
        "dirty-lib: non-adjacent kept span NOT bumped",
        spans1[0].uuid_ === spans0[0].uuid_ &&
            spans1[0].domVersion_ === undefined,
    );
    check("dirty-lib: round-trips", roundTrips(store));
}

rawLog(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
