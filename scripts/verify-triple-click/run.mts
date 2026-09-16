/**
 * Verification for the multi-click (triple-click) selection takeover
 * (kernel EditorController.handleMouseDown_, issue #42).
 *
 * The DOM half of the takeover (mousedown interception, caret-from-point,
 * getDomByCursor endpoint snapping) needs a real browser; what this harness
 * pins down headlessly is the two layers the takeover is built on:
 *
 *   1. getLineExtent — the pure extent math that decides what "the
 *      paragraph" means inside one render block (never crosses "\n", so a
 *      selection built from it can never leave the block);
 *   2. the kernel replace contract for the coordinate shapes the takeover
 *      produces — replacing a table cell's own extent keeps the grid
 *      intact (the issue #42 corruption), replacing a code line's extent
 *      keeps the fences, and the heading coordinate boundary (visible
 *      text starts after the concealed "# ") is what preserves block
 *      type at the chain layer.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-triple-click/run.mts
 */
import { EditorStore } from "@do-md/core-react";
import { getLineExtent } from "../../.packages/@do-md/core/src/editor/controller/lib/getLineExtent";

let passed = 0;
const failures: string[] = [];
const eq = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) passed += 1;
    else failures.push(`${name}\n     got: ${a}\n  expect: ${e}`);
};

// ------------------------------------------------------------ getLineExtent
eq("single line, mid click", getLineExtent("Test", 2), { start: 0, end: 4 });
eq("single line, at start", getLineExtent("Test", 0), { start: 0, end: 4 });
eq("single line, at end", getLineExtent("Test", 4), { start: 0, end: 4 });
eq("empty text", getLineExtent("", 0), { start: 0, end: 0 });
eq(
    "multiline, first line",
    getLineExtent("line one\nline two", 3),
    { start: 0, end: 8 },
);
eq(
    "multiline, second line",
    getLineExtent("line one\nline two", 12),
    { start: 9, end: 17 },
);
eq(
    "offset exactly on the newline belongs to the line it terminates",
    getLineExtent("line one\nline two", 8),
    { start: 0, end: 8 },
);
eq(
    "offset right after the newline starts the next line",
    getLineExtent("line one\nline two", 9),
    { start: 9, end: 17 },
);
eq("leading newline, click at 0", getLineExtent("\nabc", 0), {
    start: 0,
    end: 0,
});
eq("leading newline, click on text", getLineExtent("\nabc", 2), {
    start: 1,
    end: 4,
});
eq("offset clamped below", getLineExtent("abc", -5), { start: 0, end: 3 });
eq("offset clamped above", getLineExtent("abc", 99), { start: 0, end: 3 });
eq("middle empty line collapses", getLineExtent("a\n\nb", 2), {
    start: 2,
    end: 2,
});

// ------------------------------------------------- kernel replace contracts
type Node_ = {
    uuid_: string;
    text_?: string;
    htmlType_?: unknown;
    htmlProps_?: Record<string, unknown>;
    children_?: Node_[];
};

const collectRenderIdNodes = (node: Node_, out: Node_[] = []): Node_[] => {
    if (node.htmlProps_?.["data-render-id"]) out.push(node);
    for (const child of node.children_ ?? []) collectRenderIdNodes(child, out);
    return out;
};

const nodeText = (node: Node_): string => {
    if (!node.children_?.length) return node.text_ ?? "";
    return node.children_.map(nodeText).join("");
};

const makeStore = (md: string) => {
    const s = new EditorStore({ editable: true, initMd: "" });
    s.resetMD(md);
    return s as EditorStore & {
        chainProduceParsedData_(cb: (chain: unknown) => void): void;
        renderData_: Node_;
    };
};

const replaceExtent = (
    s: ReturnType<typeof makeStore>,
    uuid: string,
    start: number,
    end: number,
    text: string,
) => {
    s.chainProduceParsedData_((chain) => {
        (chain as {
            replaceSelect_(c: { uuid: string; offset: number }[], t: string): void;
        }).replaceSelect_(
            [
                { uuid, offset: start },
                { uuid, offset: end },
            ],
            text,
        );
    });
};

const TABLE_DOC =
    "| Test | Test-2 |\n| --- | --- |\n| Test-3 | Test-4 |\n\nAfter paragraph\n";

// Table: replacing a cell's own extent keeps the grid (issue #42's exact
// corruption was the cell wall being eaten by a spilled selection end).
{
    const s = makeStore(TABLE_DOC);
    const CELL_TEXTS = ["Test", "Test-2", "Test-3", "Test-4"];
    const cells = collectRenderIdNodes(s.renderData_).filter((n) =>
        CELL_TEXTS.includes(nodeText(n)),
    );
    eq("table doc exposes 4 addressable cell blocks", cells.length, 4);

    // First cell of row 1 (the comment repro).
    const first = cells.find((n) => nodeText(n) === "Test")!;
    replaceExtent(s, first.uuid_, 0, 4, "Wrong");
    const lines = s.toMarkdown().split("\n");
    eq("first cell replaced, row keeps 2 cells", lines[0], "| Wrong  | Test-2 |");
    eq("second row untouched", lines[2], "| Test-3 | Test-4 |");
}
{
    // Last column of the last row (the original issue: the next block in
    // document order is outside the table).
    const s = makeStore(TABLE_DOC);
    const last = collectRenderIdNodes(s.renderData_).find(
        (n) => nodeText(n) === "Test-4",
    )!;
    replaceExtent(s, last.uuid_, 0, 6, "Edited");
    const lines = s.toMarkdown().split("\n");
    eq("last cell replaced in place", lines[2], "| Test-3 | Edited |");
    eq("block after the table untouched", lines[4], "After paragraph");
}

// Paragraph: replacing its full extent keeps it a separate block.
{
    const s = makeStore("Paragraph one\n\nParagraph two\n");
    const p1 = collectRenderIdNodes(s.renderData_).find(
        (n) => n !== s.renderData_ && nodeText(n) === "Paragraph one",
    )!;
    replaceExtent(s, p1.uuid_, 0, 13, "Replaced");
    eq(
        "paragraphs stay separate blocks",
        s.toMarkdown().split("\n").filter(Boolean),
        ["Replaced", "Paragraph two"],
    );
}

// Heading: the visible text extent starts AFTER the concealed "# " (the
// endpoint snapping measures offset 2) — at the chain layer those
// coordinates preserve the heading. (Whether the controller's
// adjustCursor_ symbol-edge affinity then folds offset 2 to 0 is a
// selection-edit semantic shared with hand-dragged selections, outside
// this harness's scope.)
{
    const s = makeStore("# Heading Title\n");
    const h = collectRenderIdNodes(s.renderData_).find(
        (n) => n !== s.renderData_,
    )!;
    replaceExtent(s, h.uuid_, 2, 15, "New Title");
    eq("heading coords 2..15 keep the marker", s.toMarkdown(), "# New Title\n");
}

// Code block: replacing the LAST code line's extent keeps the fences —
// the other spill victim of the native gesture (the closing fence would
// have been swallowed).
{
    const s = makeStore("```js\nline one\nline two\n```\n");
    // The deepest render-id node containing the code — the PreCode area
    // (the Pre root matches too, so take the LAST collected, child after
    // parent in collection order).
    const code = collectRenderIdNodes(s.renderData_)
        .filter((n) => nodeText(n).includes("line one"))
        .at(-1)!;
    const codeText = nodeText(code);
    eq("code area text", codeText, "line one\nline two");
    const extent = getLineExtent(codeText, codeText.indexOf("two"));
    eq("last code line extent", extent, { start: 9, end: 17 });
    replaceExtent(s, code.uuid_, extent.start, extent.end, "changed");
    eq(
        "fences intact, line replaced",
        s.toMarkdown(),
        "```js\nline one\nchanged\n```\n",
    );
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\n" + failures.map((f) => "  ✗ " + f).join("\n"));
    process.exit(1);
}
