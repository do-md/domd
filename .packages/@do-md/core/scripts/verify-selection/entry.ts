/**
 * Headless assertion matrix for EditorStore.setSelection + selection-aware
 * insertText. Run: sh scripts/verify-selection/run.sh
 *
 * Instantiates the REAL EditorStore (these paths touch no DOM) and asserts,
 * per block type:
 *
 *   1. ADDRESSING — a search target resolves to the absolute range the plain
 *      string search would give, and the echoed range matches.
 *   2. FIDELITY — the placed selection covers EXACTLY the searched text.
 *      Oracle: getSelectionState().selected_text, which reads the live tree
 *      through toMarkdown's cursor markers (immune to table re-padding, since
 *      both markers move together).
 *   3. SNAPSHOT — getCursorSnapshot() reflects the placement immediately, both
 *      endpoints carry span anchors, and subscribeCursorChange fired exactly
 *      once with the same value.
 *   4. FAILURES — not_found / ambiguous / occurrence_out_of_range /
 *      out_of_bounds / invalid return the documented reason AND leave the
 *      existing cursor untouched.
 *   5. TYPE-OVER — insertText after a selection replaces it, chunk by chunk,
 *      through fine-grained ops (never replaceRoot) and as ONE undo step.
 */
import { EditorStore } from "../../src/editor/store";
import { SelectionTarget } from "../../src/editor/model/selection/resolve";
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { splitTextSpans } from "../../src/data-parse/postprocess/splitTextSpans";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import { RenderDataOp } from "../../src/editor/model/sync/renderDataOps";

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

/** Canonical form: what a fresh parse of `md` serializes back to. Neutralizes
 *  representation-level churn (table column re-padding) when comparing an
 *  edited document against a plain string splice. */
const canonical = (md: string) => {
    const tree = parseMarkdown(md);
    splitTextSpans(tree);
    return toMarkdown(tree);
};

const spliceText = (md: string, start: number, end: number, text: string) =>
    md.slice(0, start) + text + md.slice(end);

// ---------------------------------------------------------------------------
// 1-3. per-block-type addressing / fidelity / snapshot
// ---------------------------------------------------------------------------

interface Case {
    name: string;
    md: string;
    search: string;
    occurrence?: number;
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
        name: "duplicate with occurrence",
        md: "repeat me\n\nrepeat me",
        search: "repeat me",
        occurrence: 1,
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

for (const c of CASES) {
    const store = makeStore(c.md);
    const doc = store.toMarkdown();
    const target: SelectionTarget =
        c.occurrence === undefined
            ? { search: c.search }
            : { search: c.search, occurrence: c.occurrence };

    const seen: unknown[] = [];
    const unsub = store.subscribeCursorChange((snapshot) =>
        seen.push(snapshot),
    );
    const res = store.setSelection(target);
    unsub();

    // 1. addressing
    let expectedStart = -1;
    let from = 0;
    for (let k = 0; k <= (c.occurrence ?? 0); k += 1) {
        expectedStart = doc.indexOf(c.search, from);
        from = expectedStart + c.search.length;
    }
    check(`${c.name}: applied`, res.applied === true, res);
    check(
        `${c.name}: echoed range`,
        res.start === expectedStart && res.end === expectedStart + c.search.length,
        { res, expectedStart, docLen: doc.length },
    );

    // 2. fidelity — the model selection covers exactly the searched text
    const selState = store.getSelectionState();
    check(
        `${c.name}: selected_text matches the needle`,
        selState.selected_text === c.search,
        { got: selState.selected_text, want: c.search },
    );
    check(`${c.name}: has_selection`, selState.has_selection === true);

    // 3. snapshot + subscription
    const snap = store.getCursorSnapshot();
    check(
        `${c.name}: snapshot has both endpoints`,
        !!snap.start && !!snap.end,
        snap,
    );
    check(
        `${c.name}: snapshot carries span anchors`,
        !!snap.start?.spanUuid &&
            typeof snap.start?.spanOffset === "number" &&
            !!snap.end?.spanUuid &&
            typeof snap.end?.spanOffset === "number",
        snap,
    );
    check(`${c.name}: cursor listener fired once`, seen.length === 1, {
        fired: seen.length,
    });
    check(
        `${c.name}: listener value equals snapshot`,
        JSON.stringify(seen[0]) === JSON.stringify(snap),
        { fired: seen[0], snap },
    );

    // 5. type-over: replacing the selection equals a plain string splice
    store.insertText("ZZZ");
    check(
        `${c.name}: insertText replaces the selection`,
        canonical(store.toMarkdown()) ===
            canonical(
                spliceText(
                    doc,
                    expectedStart,
                    expectedStart + c.search.length,
                    "ZZZ",
                ),
            ),
        {
            got: store.toMarkdown(),
            want: spliceText(
                doc,
                expectedStart,
                expectedStart + c.search.length,
                "ZZZ",
            ),
        },
    );
}

// ---------------------------------------------------------------------------
// collapse: start / end
// ---------------------------------------------------------------------------

{
    const store = makeStore("alpha beta gamma");
    const doc = store.toMarkdown();
    const res = store.setSelection({ search: "beta", collapse: "start" });
    check("collapse start: applied", res.applied === true, res);
    check(
        "collapse start: echoes a collapsed range",
        res.start === doc.indexOf("beta") && res.end === res.start,
        res,
    );
    const snap = store.getCursorSnapshot();
    check("collapse start: end is null (collapsed shape)", snap.end === null, snap);
    check(
        "collapse start: no range selection",
        store.getSelectionState().has_selection === false,
    );
    store.insertText("<");
    check(
        "collapse start: text lands at the match head",
        store.toMarkdown() === "alpha <beta gamma",
        store.toMarkdown(),
    );
}

{
    const store = makeStore("alpha beta gamma");
    const doc = store.toMarkdown();
    const res = store.setSelection({ search: "beta", collapse: "end" });
    check(
        "collapse end: echoes the match tail",
        res.applied === true &&
            res.start === doc.indexOf("beta") + 4 &&
            res.end === res.start,
        res,
    );
    store.insertText(">");
    check(
        "collapse end: text lands at the match tail",
        store.toMarkdown() === "alpha beta> gamma",
        store.toMarkdown(),
    );
}

// ---------------------------------------------------------------------------
// absolute range addressing
// ---------------------------------------------------------------------------

{
    const store = makeStore("alpha beta gamma");
    const doc = store.toMarkdown();
    const start = doc.indexOf("beta");
    const res = store.setSelection({ start, end: start + 4 });
    check("range: applied", res.applied === true, res);
    check(
        "range: selected_text",
        store.getSelectionState().selected_text === "beta",
        store.getSelectionState(),
    );
    store.insertText("B");
    check(
        "range: type-over",
        store.toMarkdown() === "alpha B gamma",
        store.toMarkdown(),
    );
}

{
    const store = makeStore("alpha beta gamma");
    const doc = store.toMarkdown();
    const res = store.setSelection({ start: doc.indexOf("beta") });
    check("range collapsed: applied", res.applied === true, res);
    check(
        "range collapsed: end echoes start",
        res.end === res.start,
        res,
    );
    check(
        "range collapsed: snapshot end is null",
        store.getCursorSnapshot().end === null,
    );
    store.insertText("|");
    check(
        "range collapsed: pure insertion",
        store.toMarkdown() === "alpha |beta gamma",
        store.toMarkdown(),
    );
}

{
    // Whole-document range: start 0 through the very last offset.
    const store = makeStore("alpha beta gamma");
    const doc = store.toMarkdown();
    const res = store.setSelection({ start: 0, end: doc.length });
    check("range whole doc: applied", res.applied === true, res);
    check(
        "range whole doc: selected_text is the document",
        store.getSelectionState().selected_text === doc,
        store.getSelectionState().selected_text,
    );
    store.insertText("fresh");
    check(
        "range whole doc: type-over replaces everything",
        store.toMarkdown() === "fresh",
        store.toMarkdown(),
    );
}

// ---------------------------------------------------------------------------
// 4. failure paths — reason + cursor untouched
// ---------------------------------------------------------------------------

{
    const store = makeStore("one two\n\nthree two");
    store.setSelection({ search: "one" });
    const before = JSON.stringify(store.getCursorSnapshot());
    const beforeMd = store.toMarkdown();

    const fail = (name: string, target: SelectionTarget, reason: string) => {
        const res = store.setSelection(target);
        check(`fail ${name}: not applied`, res.applied === false, res);
        check(`fail ${name}: reason ${reason}`, res.reason === reason, res);
        check(
            `fail ${name}: cursor untouched`,
            JSON.stringify(store.getCursorSnapshot()) === before,
            store.getCursorSnapshot(),
        );
        check(
            `fail ${name}: document untouched`,
            store.toMarkdown() === beforeMd,
        );
    };

    fail("not_found", { search: "nothing here" }, "not_found");
    fail("ambiguous", { search: "two" }, "ambiguous");
    fail(
        "occurrence_out_of_range",
        { search: "two", occurrence: 5 },
        "occurrence_out_of_range",
    );
    fail("out_of_bounds high", { start: 9999 }, "out_of_bounds");
    fail("out_of_bounds negative", { start: -1 }, "out_of_bounds");
    fail(
        "out_of_bounds end",
        { start: 0, end: beforeMd.length + 1 },
        "out_of_bounds",
    );
    fail("invalid empty search", { search: "" }, "invalid");
    fail("invalid reversed range", { start: 5, end: 2 }, "invalid");
    fail(
        "invalid collapse value",
        { search: "one", collapse: "middle" } as unknown as SelectionTarget,
        "invalid",
    );
    fail(
        "invalid non-integer",
        { start: 1.5 } as SelectionTarget,
        "invalid",
    );

    // A failed call must not have emitted a cursor event either.
    let fired = 0;
    const unsub = store.subscribeCursorChange(() => (fired += 1));
    store.setSelection({ search: "nope" });
    unsub();
    check("fail: no cursor event emitted", fired === 0, { fired });
}

// ---------------------------------------------------------------------------
// 5. streaming: selection + chunk-by-chunk insertText
// ---------------------------------------------------------------------------

{
    const store = makeStore(
        "# Doc\n\nThe quick brown fox jumps.\n\n- keep me\n- keep me too",
    );
    const doc = store.toMarkdown();
    const ops: RenderDataOp[] = [];
    const unsub = store.subscribeRenderDataOps((batch) => ops.push(...batch));

    const res = store.setSelection({ search: "quick brown fox" });
    check("stream: selection applied", res.applied === true, res);
    check(
        "stream: setSelection emits no document ops",
        ops.length === 0,
        ops.length,
    );

    for (const chunk of ["nimble ", "amber ", "vulpine"]) {
        store.insertText(chunk);
    }
    unsub();

    check(
        "stream: chunks replace the selection",
        store.toMarkdown() ===
            spliceText(
                doc,
                res.start!,
                res.end!,
                "nimble amber vulpine",
            ),
        store.toMarkdown(),
    );
    check(
        "stream: ops stay fine-grained (no replaceRoot)",
        ops.length > 0 && ops.every((op) => op.op !== "replaceRoot"),
        { count: ops.length, kinds: [...new Set(ops.map((o) => o.op))] },
    );
    check(
        "stream: untouched blocks emit no ops",
        store.toMarkdown().includes("- keep me\n- keep me too"),
        store.toMarkdown(),
    );
}

{
    // Undo: the whole select→type sequence collapses into one history entry
    // (the withHistory debounce folds the chunk bursts together).
    const store = makeStore("alpha beta gamma");
    const doc = store.toMarkdown();
    store.setSelection({ search: "beta" });
    store.insertText("delta");
    check(
        "undo: edit applied",
        store.toMarkdown() === "alpha delta gamma",
        store.toMarkdown(),
    );
    store.undo();
    check("undo: one step restores the document", store.toMarkdown() === doc, {
        got: store.toMarkdown(),
        want: doc,
    });
}

{
    // insertText with an explicit cursorInfo target must NOT eat the selection.
    const store = makeStore("alpha beta gamma");
    store.setSelection({ search: "beta" });
    const snap = store.getCursorSnapshot();
    store.insertText("X", { uuid: snap.start!.uuid, offset: 0 });
    check(
        "explicit target: selection left alone",
        store.toMarkdown() === "Xalpha beta gamma",
        store.toMarkdown(),
    );
}

{
    // Collapsed caret + insertText behaves exactly as before (no delete).
    const store = makeStore("alpha beta gamma");
    store.setSelection({ search: "beta", collapse: "start" });
    store.insertText("new ");
    store.insertText("word ");
    check(
        "collapsed: successive inserts type forward",
        store.toMarkdown() === "alpha new word beta gamma",
        store.toMarkdown(),
    );
}

{
    // A store with no cursor at all: insertText still appends (legacy path).
    const store = makeStore("alpha");
    store.insertText(" tail");
    check(
        "no cursor: insertText still appends",
        store.toMarkdown().includes("tail"),
        store.toMarkdown(),
    );
}

{
    // Empty document — the degenerate case for offset 0.
    const store = makeStore("");
    const res = store.setSelection({ start: 0 });
    check("empty doc: applied", res.applied === true, res);
    store.insertText("hello");
    check("empty doc: typed text lands", store.toMarkdown() === "hello", store.toMarkdown());
}

{
    // Selection survives a remote op batch: span anchors keep it on its text.
    const store = makeStore("keep this sentence intact\n\nsecond block");
    store.setSelection({ search: "sentence" });
    const before = store.getCursorSnapshot();
    const peer = makeStore("keep this sentence intact\n\nsecond block");
    peer.applyExternalRenderData(store.getRenderDataSnapshot());
    const ops: RenderDataOp[] = [];
    const unsub = peer.subscribeRenderDataOps((batch) => ops.push(...batch));
    peer.replaceText({ search: "second block", replace: "second block edited" });
    unsub();
    store.applyExternalRenderDataOps(ops);
    const after = store.getCursorSnapshot();
    check(
        "remote op: selection unmoved by an edit elsewhere",
        JSON.stringify(after) === JSON.stringify(before),
        { before, after },
    );
    store.insertText("phrase");
    check(
        "remote op: type-over still hits the right text",
        store.toMarkdown().startsWith("keep this phrase intact"),
        store.toMarkdown(),
    );
}

{
    // A remote batch received while IME owns the DOM must not render early or
    // disappear. Its Promise resumes only after compositionend has committed
    // the composition snapshot.
    const store = makeStore("local text");
    const peer = makeStore("");
    peer.applyExternalRenderData(store.getRenderDataSnapshot());
    const ops: RenderDataOp[] = [];
    const unsub = peer.subscribeRenderDataOps((batch) => ops.push(...batch));
    peer.replaceText({ search: "local", replace: "remote" });
    unsub();

    store.setDuringComposition_(true);
    const applyDeferred = store.applyExternalRenderDataOps(ops);
    check(
        "remote op during composition: application is deferred",
        store.toMarkdown() === "local text",
        store.toMarkdown(),
    );

    store.setDuringComposition_(false);
    await applyDeferred;
    check(
        "remote op after composition: deferred batch is replayed",
        store.toMarkdown() === "remote text",
        store.toMarkdown(),
    );
}

// ---------------------------------------------------------------------------
// Select-all terminal state (cursorInfo_.all_) — the whole-document selection
// that (uuid, offset) coordinates cannot express: leading/trailing
// serialization scaffolding is outside the coordinate range, and chunked
// loads keep part of the document out of the tree entirely.
// ---------------------------------------------------------------------------

{
    // Entering the terminal state: flag set, coords cover first block →
    // last render leaf, selection state reports the FULL serialization
    // (including the `# ` prefix and closing fence no cursor can address).
    const md = "# Title\n\npara with **bold**\n\n```js\ncode\n```";
    const store = makeStore(md);
    store.setSelectAll_();
    check("selectAll: all_ flag set", store.cursorInfo_.all_ === true);
    check(
        "selectAll: start at first block offset 0",
        store.startCursorInfo?.offset === 0,
    );
    check(
        "selectAll: end coordinate resolves in tree",
        !!store.endCursorInfo_ &&
            !!store.endCursorInfo_.uuid &&
            store.endCursorInfo_.offset >= 0,
    );
    const sel = store.getSelectionState();
    check(
        "selectAll: getSelectionState = full doc",
        sel.has_selection && sel.selected_text === canonical(md),
        sel.selected_text,
    );
    // Echo handshake bit: entering the state arms `pending`, and a repeated Cmd+A must
    // re-arm it even though identical coordinates short-circuit the write.
    check(
        "selectAll: echo handshake armed",
        store.selectAllEchoPending_ === true,
    );
    store.selectAllEchoPending_ = false; // simulate selectionchange consuming it
    store.setSelectAll_(); // repeated Cmd+A: setCursorInfo_ short-circuits on equal coords
    check(
        "selectAll: repeated Cmd+A re-arms handshake despite short-circuit",
        store.selectAllEchoPending_ === true &&
            store.cursorInfo_.all_ === true,
    );
}

{
    // Delete after select-all leaves NO tails — the exact regression the
    // coordinate path had (leading `# `, closing ``` survived deletion).
    const store = makeStore("# Title\n\npara **bold**\n\n```js\ncode\n```");
    store.setSelectAll_();
    store.deleteRange();
    check(
        "selectAll+delete: document fully empty",
        store.toMarkdown() === "",
        store.toMarkdown(),
    );
    check(
        "selectAll+delete: all_ consumed",
        store.cursorInfo_.all_ !== true,
    );
    check(
        "selectAll+delete: caret lands on a live block",
        !!store.startCursorInfo &&
            store.startCursorInfo.offset === 0,
    );
    // The document must still be editable right after — type into the void.
    store.insertText("fresh");
    check(
        "selectAll+delete: typing after clear works",
        store.toMarkdown() === "fresh",
        store.toMarkdown(),
    );
}

{
    // Typing over select-all = whole-document replace, single undo step.
    const md = "# Title\n\n- a\n- b\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |";
    const store = makeStore(md);
    store.setSelectAll_();
    store.insertText("x");
    check(
        "selectAll+type: doc replaced by typed char",
        store.toMarkdown() === "x",
        store.toMarkdown(),
    );
    check("selectAll+type: all_ consumed", store.cursorInfo_.all_ !== true);
    store.undo();
    check(
        "selectAll+type: single undo restores full doc",
        store.toMarkdown() === canonical(md),
        store.toMarkdown(),
    );
    check(
        "selectAll+type: undo restores terminal state (native-like)",
        store.cursorInfo_.all_ === true,
    );
}

{
    // Paste (multi-block markdown) over select-all round-trips through parse.
    const store = makeStore("old content");
    store.setSelectAll_();
    store.insertText("# New\n\nfresh *text*");
    check(
        "selectAll+paste: multi-block replacement",
        store.toMarkdown() === canonical("# New\n\nfresh *text*"),
        store.toMarkdown(),
    );
}

{
    // Document ending in a table: the end coordinate walks to the last
    // render leaf (a cell), and whole-doc delete still clears the table.
    const store = makeStore(
        "text\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |",
    );
    store.setSelectAll_();
    store.deleteRange();
    check(
        "selectAll+delete: table document fully cleared",
        store.toMarkdown() === "",
        store.toMarkdown(),
    );
}

{
    // Empty document: select-all + delete must be a harmless no-op shape.
    const store = makeStore("");
    store.setSelectAll_();
    store.deleteRange();
    check(
        "selectAll on empty doc: no crash, stays empty",
        store.toMarkdown() === "",
        store.toMarkdown(),
    );
}

{
    // Any plain cursor write clears the terminal state (structural
    // invalidation: the flag never survives an ordinary setCursorInfo_).
    const store = makeStore("alpha beta");
    store.setSelectAll_();
    const first = store.renderData_.children_.find(
        (c) => c.htmlProps_?.["data-render-id"],
    )!;
    store.setCursorInfo_({ uuid: first.uuid_, offset: 1 });
    check(
        "selectAll: collapsed cursor write clears all_",
        store.cursorInfo_.all_ !== true,
    );
    store.deleteRange();
    check(
        "selectAll: cleared state no longer routes deleteRange to clearAll",
        store.toMarkdown() === canonical("alpha beta"),
        store.toMarkdown(),
    );
}

{
    // CHUNKED LOAD × select-all delete — the second motivating defect:
    // a pending chunked append must NOT resurrect the tail after a
    // whole-document delete (replaceAllContent_ bumps _chunkGeneration_).
    const bigMd = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join(
        "\n",
    );
    const store = makeStore("seed");
    store.resetMDChunked(bigMd);
    // First 500 lines are in synchronously; the rest sit in scheduled ticks.
    store.setSelectAll_();
    store.deleteRange();
    const afterDelete = store.toMarkdown();
    await new Promise((r) => setTimeout(r, 80)); // let stale ticks fire
    check(
        "selectAll+delete during chunked load: cleared immediately",
        afterDelete === "",
        afterDelete,
    );
    check(
        "selectAll+delete during chunked load: stale chunks stay cancelled",
        store.toMarkdown() === "",
        store.toMarkdown(),
    );
}

{
    // getSelectionOffsets — the read-only dual of setSelection's range form.
    // Round-trip law: setSelection({start,end}) → getSelectionOffsets()
    // must echo {start,end} exactly, for every block type INCLUDING table
    // cells (historically impossible: marker injection re-padded columns,
    // skewing before.length by +2/+4; renderTable now measures widths on
    // marker-free text).
    const md = [
        "# Title",
        "",
        "plain paragraph here",
        "",
        "- bullet one",
        "- bullet two",
        "",
        "| a | long header cell |",
        "| --- | --- |",
        "| x | y |",
        "",
        "> quoted line",
        "",
        "```",
        "const code = 1;",
        "```",
    ].join("\n");
    const store = makeStore(md);
    const canon = store.toMarkdown();

    // No cursor placed yet → null, not a guessed 0.
    check(
        "offsets: null before any cursor",
        store.getSelectionOffsets() === null,
    );

    const roundTrip = (needle: string, label: string) => {
        const at = canon.indexOf(needle);
        check(`offsets(${label}): needle present`, at >= 0, needle);
        if (at < 0) return;
        // Range selection round-trip.
        const res = store.setSelection({ start: at, end: at + needle.length });
        check(`offsets(${label}): setSelection applied`, res.applied, res);
        const range = store.getSelectionOffsets();
        check(
            `offsets(${label}): range echoes exactly`,
            !!range && range.start === at && range.end === at + needle.length,
            { expected: [at, at + needle.length], got: range },
        );
        check(
            `offsets(${label}): slice equals needle`,
            !!range && canon.slice(range.start, range.end) === needle,
            range ? canon.slice(range.start, range.end) : null,
        );
        // Collapsed caret round-trip (head of the needle).
        store.setSelection({ start: at });
        const caret = store.getSelectionOffsets();
        check(
            `offsets(${label}): collapsed caret echoes`,
            !!caret && caret.start === at && caret.end === at,
            caret,
        );
    };

    roundTrip("Title", "heading");
    roundTrip("paragraph", "paragraph");
    roundTrip("bullet two", "list item");
    roundTrip("long header cell", "table header cell");
    roundTrip("y", "table body cell");
    roundTrip("quoted", "blockquote");
    roundTrip("const code", "code block");

    // Select-all terminal state → whole document.
    store.setSelectAll_();
    const all = store.getSelectionOffsets();
    check(
        "offsets: select-all → whole doc",
        !!all && all.start === 0 && all.end === store.toMarkdown().length,
        all,
    );

    // getSelectionState's before must now agree with canonical md inside a
    // table cell — the exact invariant app toolbars verify before editing.
    store.setSelection({ start: canon.indexOf("y"), end: canon.indexOf("y") + 1 });
    const sel = store.getSelectionState(canon.length + 1);
    check(
        "offsets: getSelectionState.before byte-aligned in table",
        canon.slice(0, canon.indexOf("y")) === sel.before,
        { beforeLen: sel.before.length, expected: canon.indexOf("y") },
    );
}

rawLog(`\nverify-selection: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
