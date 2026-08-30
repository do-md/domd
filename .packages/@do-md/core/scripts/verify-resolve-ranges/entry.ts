/**
 * Headless assertion matrix for EditorStore.resolveRanges — the batch,
 * side-effect-free companion of setSelection. Run:
 *   sh scripts/verify-resolve-ranges/run.sh
 *
 * Instantiates the REAL EditorStore (no DOM) and asserts:
 *
 *   1. EQUIVALENCE — for every corpus needle, resolveRanges returns exactly
 *      the block coordinates setSelection places for the same absolute range.
 *      Oracle: getCursorSnapshot after setSelection on the same store —
 *      resolveRanges runs FIRST (on a virgin cursor), so the equivalence also
 *      proves resolution is independent of cursor state. Failure equivalence
 *      included: resolveRanges yields null exactly when setSelection reports
 *      applied:false.
 *   2. PURITY — resolveRanges fires no cursor event, leaves the cursor
 *      snapshot bit-identical, emits no renderData ops and does not touch the
 *      document text.
 *   3. BATCH SHAPE — the result array corresponds positionally to the
 *      arguments; malformed / out-of-bounds entries yield null while valid
 *      neighbours still resolve.
 *   4. COLLAPSED — `end` omitted or equal to `start` echoes the start anchor
 *      at both endpoints.
 */
import { EditorStore } from "../../src/editor/store";
import { SelectionRangeTarget } from "../../src/editor/model/selection/resolve";

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

const makeStore = (initMd: string) =>
    new EditorStore({ editable: true, initMd });

// ---------------------------------------------------------------------------
// 1. Equivalence with setSelection, per block type
// ---------------------------------------------------------------------------

interface Case {
    name: string;
    md: string;
    search: string;
}

const CASES: Case[] = [
    { name: "paragraph", md: "alpha beta gamma", search: "beta" },
    {
        name: "paragraph mid-doc",
        md: "first para\n\nsecond para here\n\nthird para",
        search: "para here",
    },
    { name: "header", md: "# Title of doc\n\nbody", search: "of doc" },
    {
        name: "inline formatting (span boundary)",
        md: "plain **bold text** tail",
        search: "bold text",
    },
    {
        name: "inline formatting incl. symbols",
        md: "plain **bold text** tail",
        search: "**bold text**",
    },
    {
        name: "unordered list item",
        md: "- first item\n- second item\n- third item",
        search: "second item",
    },
    {
        name: "ordered list item",
        md: "1. alpha step\n2. beta step\n3. gamma step",
        search: "beta step",
    },
    {
        name: "nested list item",
        md: "- outer one\n  - inner deep\n- outer two",
        search: "inner deep",
    },
    {
        name: "blockquote",
        md: "> quoted line one\n> quoted line two",
        search: "line two",
    },
    {
        name: "table body cell",
        md: "| a  | bb |\n| -- | -- |\n| cc | dd |",
        search: "cc",
    },
    {
        name: "table widest cell (padding reflow)",
        md: "| h | col |\n| - | --- |\n| x | wideeeee |\n| y | z |",
        search: "wideeeee",
    },
    {
        name: "table header cell",
        md: "| name | value |\n| ---- | ----- |\n| a    | b     |",
        search: "value",
    },
    {
        name: "code block body",
        md: "```js\nconst x = 1;\nconst y = 2;\n```",
        search: "const y = 2;",
    },
    {
        name: "paragraph after code block",
        md: "```js\nfoo();\n```\n\ntrailing paragraph",
        search: "trailing paragraph",
    },
    {
        name: "checkbox list",
        md: "- [ ] todo one\n- [x] done two",
        search: "todo one",
    },
    {
        name: "multi-line selection inside a paragraph",
        md: "line one soft\nline two soft",
        search: "soft\nline two",
    },
    {
        name: "cross-block selection",
        md: "para one here\n\npara two here",
        search: "one here\n\npara two",
    },
];

/** Every non-overlapping occurrence of `needle`, left to right. */
const occurrencesOf = (doc: string, needle: string): SelectionRangeTarget[] => {
    const out: SelectionRangeTarget[] = [];
    let from = 0;
    for (;;) {
        const at = doc.indexOf(needle, from);
        if (at === -1) return out;
        out.push({ start: at, end: at + needle.length });
        from = at + needle.length;
    }
};

for (const c of CASES) {
    const store = makeStore(c.md);
    const doc = store.toMarkdown();
    const targets = occurrencesOf(doc, c.search);
    check(`${c.name}: needle occurs`, targets.length > 0, { doc });

    // resolveRanges first — the cursor is still virgin here.
    const resolved = store.resolveRanges(...targets);
    check(
        `${c.name}: one slot per target`,
        resolved.length === targets.length,
        resolved,
    );

    targets.forEach((target, i) => {
        const label = targets.length > 1 ? `${c.name} #${i}` : c.name;
        const res = store.setSelection(target);
        const slot = resolved[i];
        check(
            `${label}: null exactly when setSelection fails`,
            (slot === null) === (res.applied === false),
            { slot, res },
        );
        if (!res.applied || slot === null) return;
        const snap = store.getCursorSnapshot();
        check(`${label}: snapshot has endpoints`, !!snap.start && !!snap.end, snap);
        check(
            `${label}: start anchor equals setSelection placement`,
            slot.start.uuid === snap.start?.uuid &&
                slot.start.offset === snap.start?.offset,
            { slot: slot.start, snap: snap.start },
        );
        check(
            `${label}: end anchor equals setSelection placement`,
            slot.end.uuid === snap.end?.uuid &&
                slot.end.offset === snap.end?.offset,
            { slot: slot.end, snap: snap.end },
        );
    });
}

// ---------------------------------------------------------------------------
// 2. Purity — no cursor event, no ops, snapshot and document untouched
// ---------------------------------------------------------------------------

{
    const store = makeStore("alpha beta gamma\n\n- item one\n- item two");
    const doc = store.toMarkdown();
    store.setSelection({ search: "beta" });
    const before = JSON.stringify(store.getCursorSnapshot());

    let cursorEvents = 0;
    let opBatches = 0;
    const offCursor = store.subscribeCursorChange(() => {
        cursorEvents += 1;
    });
    const offOps = store.subscribeRenderDataOps(() => {
        opBatches += 1;
    });
    const resolved = store.resolveRanges(
        ...occurrencesOf(doc, "item"),
        { start: 0, end: doc.length },
    );
    offCursor();
    offOps();

    check("purity: all slots resolved", resolved.every((slot) => slot !== null));
    check("purity: zero cursor events", cursorEvents === 0, cursorEvents);
    check("purity: zero op batches", opBatches === 0, opBatches);
    check(
        "purity: cursor snapshot untouched",
        JSON.stringify(store.getCursorSnapshot()) === before,
    );
    check("purity: document untouched", store.toMarkdown() === doc);
}

// ---------------------------------------------------------------------------
// 3. Batch shape — positional correspondence, per-slot failure
// ---------------------------------------------------------------------------

{
    const store = makeStore("repeat me\n\nrepeat me");
    const doc = store.toMarkdown();
    const [first, second] = occurrencesOf(doc, "repeat me");
    const resolved = store.resolveRanges(
        first,
        { start: -1, end: 2 }, // out of bounds
        second,
        { start: 4, end: 2 }, // malformed (end < start)
        { start: 0, end: doc.length + 10 }, // out of bounds
        { start: 2.5, end: 4 } as SelectionRangeTarget, // malformed (non-integer)
    );
    check("batch: six slots", resolved.length === 6, resolved);
    check("batch: valid slot 0 resolves", resolved[0] !== null);
    check("batch: invalid slot 1 is null", resolved[1] === null);
    check("batch: valid slot 2 resolves", resolved[2] !== null);
    check("batch: invalid slot 3 is null", resolved[3] === null);
    check("batch: invalid slot 4 is null", resolved[4] === null);
    check("batch: invalid slot 5 is null", resolved[5] === null);
    check(
        "batch: duplicate needles land on distinct blocks",
        resolved[0]?.start.uuid !== resolved[2]?.start.uuid,
        resolved,
    );
}

// ---------------------------------------------------------------------------
// 4. Collapsed ranges echo the start anchor
// ---------------------------------------------------------------------------

{
    const store = makeStore("alpha beta gamma");
    const collapsed = store.resolveRanges({ start: 6 }, { start: 6, end: 6 });
    for (const [i, slot] of collapsed.entries()) {
        check(`collapsed #${i}: resolves`, slot !== null);
        check(
            `collapsed #${i}: end echoes start`,
            slot !== null &&
                slot.start.uuid === slot.end.uuid &&
                slot.start.offset === slot.end.offset,
            slot,
        );
    }
    const res = store.setSelection({ start: 6 });
    const snap = store.getCursorSnapshot();
    check("collapsed: setSelection applied", res.applied === true, res);
    check(
        "collapsed: anchor equals setSelection placement",
        collapsed[0]?.start.uuid === snap.start?.uuid &&
            collapsed[0]?.start.offset === snap.start?.offset,
        { slot: collapsed[0], snap: snap.start },
    );

    // Zero arguments → empty result, still pure.
    check("collapsed: empty call yields []", store.resolveRanges().length === 0);
}

rawLog(`resolveRanges verification: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
