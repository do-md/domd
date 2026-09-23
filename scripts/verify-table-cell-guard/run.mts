/**
 * Verification for the table-cell boundary guard.
 *
 * A table is ONE top-level block whose cells are nested render blocks, so both
 * endpoints of a cross-cell selection resolve to the same top-level index. The
 * selection edit then serializes the whole table and replaces everything
 * between the two cursor markers — and in markdown that span contains the
 * ` | ` separating the cells. Deleting it merged two cells into one and left
 * the row a cell short, so the document no longer round-tripped as a grid.
 *
 * The cursor pair is set directly here rather than through `setSelection`,
 * because that API REFUSES a range straddling the separator (applied:false,
 * reason:"invalid") — scaffolding offsets are not expressible as cursor
 * coordinates. Only a DOM selection can span two cells in the running app,
 * which is why the bug was reachable there and nowhere else; `setCursorInfo_`
 * reproduces that state faithfully and headlessly.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-table-cell-guard/run.mts
 */
import { EditorStore } from "@do-md/core-react";

let passed = 0;
const failures: string[] = [];
const eq = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) passed += 1;
    else failures.push(`${name}\n     got: ${a}\n  expect: ${e}`);
};

const TABLE = "| Test | Test-2 |\n| --- | --- |\n| Test-3 | Test-4 |\n";

type Node_ = {
    uuid_: string;
    htmlType_: string;
    text_?: string;
    children_?: Node_[];
    htmlProps_: Record<string, string>;
};

const mk = (md: string) => {
    const store = new EditorStore({ editable: true, initMd: "" });
    store.resetMD(md);
    return store;
};

/** The render block (the cell's <p>) inside each TH/TD, in document order. */
const cellBlocks = (root: Node_): string[] => {
    const out: string[] = [];
    const firstRenderBlock = (n: Node_): string | null => {
        if (n.htmlProps_?.["data-render-id"] && n.htmlType_ !== "TH" && n.htmlType_ !== "TD") {
            return n.uuid_;
        }
        for (const c of n.children_ ?? []) {
            const hit = firstRenderBlock(c);
            if (hit) return hit;
        }
        return null;
    };
    const walk = (n: Node_) => {
        if (n.htmlType_ === "TH" || n.htmlType_ === "TD") {
            const block = firstRenderBlock(n);
            if (block) out.push(block);
            return;
        }
        for (const c of n.children_ ?? []) walk(c);
    };
    walk(root);
    return out;
};

/** Body rows as cell-text arrays, ignoring the delimiter row.
 *
 *  The delimiter test looks at the CELLS, not the raw line: after a delete a
 *  body row can read `|  | Test-2 |`, and a looser pattern counts that as the
 *  delimiter and silently hides the row the assertion is about. */
const rows = (store: EditorStore) =>
    store
        .toMarkdown()
        .split("\n")
        .filter((l) => l.startsWith("|"))
        .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));

const setPair = (store: EditorStore, aUuid: string, aOff: number, bUuid: string, bOff: number) =>
    (store as unknown as {
        setCursorInfo_: (s: unknown, e: unknown) => void;
    }).setCursorInfo_({ uuid: aUuid, offset: aOff }, { uuid: bUuid, offset: bOff });

// ── the regression: typing over a cross-cell selection ──────────────────────
{
    const s = mk(TABLE);
    const cells = cellBlocks((s as unknown as { renderData_: Node_ }).renderData_);
    eq("four cells found", cells.length, 4);
    setPair(s, cells[0], 0, cells[1], 0);
    s.insertText("Wrong");
    eq("cross-cell replace keeps both cells", rows(s), [
        ["Wrong", "Test-2"],
        ["Test-3", "Test-4"],
    ]);
}

// Across a ROW boundary — the shape reported upstream (last column into the
// next row's first column).
{
    const s = mk(TABLE);
    const cells = cellBlocks((s as unknown as { renderData_: Node_ }).renderData_);
    setPair(s, cells[1], 0, cells[2], 0);
    s.insertText("X");
    const r = rows(s);
    eq("cross-row replace keeps the grid shape", [r.length, r[0]?.length, r[1]?.length], [2, 2, 2]);
    eq("cross-row replace keeps the later row intact", r[1], ["Test-3", "Test-4"]);
}

// Deleting across cells (empty insert) must not merge them either.
{
    const s = mk(TABLE);
    const cells = cellBlocks((s as unknown as { renderData_: Node_ }).renderData_);
    setPair(s, cells[0], 0, cells[1], 0);
    s.deleteRange();
    const r = rows(s);
    eq("cross-cell delete keeps the grid shape", [r.length, r[0]?.length, r[1]?.length], [2, 2, 2]);
}

// Selection ORDER must not matter — the clamp keeps the earlier endpoint
// whichever way round the pair arrives.
{
    const s = mk(TABLE);
    const cells = cellBlocks((s as unknown as { renderData_: Node_ }).renderData_);
    setPair(s, cells[1], 0, cells[0], 0);
    s.insertText("Rev");
    const r = rows(s);
    eq("reversed cross-cell pair keeps the grid shape", [r.length, r[0]?.length, r[1]?.length], [2, 2, 2]);
}

// ── what must NOT change ────────────────────────────────────────────────────
{
    const s = mk(TABLE);
    const cells = cellBlocks((s as unknown as { renderData_: Node_ }).renderData_);
    setPair(s, cells[0], 0, cells[0], 4);
    s.insertText("Ok");
    eq("within-cell replace is unaffected", rows(s), [
        ["Ok", "Test-2"],
        ["Test-3", "Test-4"],
    ]);
}
{
    // Between paragraphs the merge is the CORRECT outcome — the guard is
    // scoped to cells precisely so this keeps working.
    const s = mk("alpha\n\nbeta\n");
    const root = (s as unknown as { renderData_: Node_ }).renderData_;
    const paras: string[] = [];
    const walk = (n: Node_) => {
        if (n.htmlType_ === "P" && n.htmlProps_?.["data-render-id"]) paras.push(n.uuid_);
        for (const c of n.children_ ?? []) walk(c);
    };
    walk(root);
    eq("two paragraphs found", paras.length, 2);
    setPair(s, paras[0], 2, paras[1], 2);
    s.insertText("-");
    eq("cross-paragraph merge still merges", s.toMarkdown().trim(), "al-ta");
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\n" + failures.map((f) => "  ✗ " + f).join("\n"));
    process.exit(1);
}
