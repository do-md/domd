/**
 * Micro-benchmark: mergeStructuralNode cost vs the parse it accompanies.
 * Run: sh scripts/bench-merge/run.sh
 *
 * The hot path is NOT the table ops — it is TYPING inside a table cell / code
 * block: every keystroke reparses the whole block (resetTextByUUID_) and then
 * mergeParsedBlock walks it. So the honest question is: how big is the merge
 * pass RELATIVE to the reparse that already runs on every keystroke?
 */
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { splitTextSpans } from "../../src/data-parse/postprocess/splitTextSpans";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import { mergeParsedBlock } from "../../src/editor/model/merge/mergeStructural";
import { ParentRenderData } from "../../src/editor/type";

/* eslint-disable no-console */
const rawLog = console.log.bind(console);
console.log = () => {};
console.time = () => {};
console.timeEnd = () => {};

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

const buildTable = (rows: number, cols: number): string => {
    const cell = (r: number, c: number) => `cell ${r}-${c} text`;
    const header =
        "| " +
        Array.from({ length: cols }, (_, c) => `head${c}`).join(" | ") +
        " |";
    const sep = "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
    const body = Array.from(
        { length: rows },
        (_, r) =>
            "| " +
            Array.from({ length: cols }, (_, c) => cell(r, c)).join(" | ") +
            " |",
    );
    return [header, sep, ...body].join("\n");
};

const parseTableBlock = (md: string): ParentRenderData => {
    const doc = parseMarkdown(md);
    splitTextSpans(doc);
    return doc.children_.find(
        (c) => c.htmlType_ === "Table",
    ) as ParentRenderData;
};

/** Simulate one keystroke: change one character in the middle cell, reparse
 *  the whole block, and merge. Returns {parseMs, mergeMs}. */
const benchKeystroke = (rows: number, cols: number, iters: number) => {
    const oldMd = buildTable(rows, cols);
    const midRow = Math.floor(rows / 2);
    const midCol = Math.floor(cols / 2);
    // The "after keystroke" text: append a char to the middle cell.
    const lines = oldMd.split("\n");
    const bodyLine = 2 + midRow;
    const cells = lines[bodyLine].slice(2, -2).split(" | ");
    cells[midCol] = cells[midCol] + "X";
    lines[bodyLine] = "| " + cells.join(" | ") + " |";
    const newMd = lines.join("\n");

    // warmup
    for (let i = 0; i < 3; i++) {
        const oldBlock = parseTableBlock(oldMd);
        const newBlock = parseTableBlock(newMd);
        mergeParsedBlock(oldBlock, newBlock, new Map());
    }

    let parseMs = 0;
    let mergeMs = 0;
    for (let i = 0; i < iters; i++) {
        const oldBlock = parseTableBlock(oldMd);

        const t0 = nowMs();
        const newBlock = parseTableBlock(newMd); // the reparse every keystroke pays
        const t1 = nowMs();
        mergeParsedBlock(oldBlock, newBlock, new Map());
        const t2 = nowMs();

        parseMs += t1 - t0;
        mergeMs += t2 - t1;
    }
    return { parseMs: parseMs / iters, mergeMs: mergeMs / iters };
};

rawLog("keystroke-in-a-cell: reparse vs merge (per-keystroke, ms avg)\n");
rawLog(
    "rows×cols   cells    parse(ms)   merge(ms)   merge/parse",
);
const cases: [number, number][] = [
    [3, 3],
    [10, 5],
    [25, 8],
    [50, 10],
    [100, 12],
    [200, 20],
];
for (const [r, c] of cases) {
    const iters = r * c > 1000 ? 40 : 200;
    const { parseMs, mergeMs } = benchKeystroke(r, c, iters);
    rawLog(
        `${`${r}×${c}`.padEnd(11)} ${String(r * c).padEnd(8)} ${parseMs
            .toFixed(3)
            .padEnd(11)} ${mergeMs.toFixed(3).padEnd(11)} ${(
            mergeMs / parseMs
        ).toFixed(2)}x`,
    );
}

rawLog("\naddTableRow-style merge (unequal-count splice path):");
for (const [r, c] of cases) {
    const oldMd = buildTable(r, c);
    const oldBlock = parseTableBlock(oldMd);
    // insert one empty row at the middle
    const lines = oldMd.split("\n");
    lines.splice(2 + Math.floor(r / 2), 0, "| " + Array.from({ length: c }, () => "").join(" | ") + " |");
    const newBlock = parseTableBlock(lines.join("\n"));
    const iters = r * c > 1000 ? 40 : 200;
    for (let i = 0; i < 3; i++)
        mergeParsedBlock(parseTableBlock(oldMd), newBlock, new Map());
    let ms = 0;
    for (let i = 0; i < iters; i++) {
        const ob = parseTableBlock(oldMd);
        const t0 = nowMs();
        mergeParsedBlock(ob, newBlock, new Map());
        ms += nowMs() - t0;
    }
    rawLog(`  ${`${r}×${c}`.padEnd(11)} merge ${(ms / iters).toFixed(3)} ms`);
}
