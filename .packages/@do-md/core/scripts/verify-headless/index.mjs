/**
 * Bare-Node headless smoke test for the public EditorStore surface.
 *
 * Runs against the BUILT dist bundle (dist/index.cjs — the exact artifact npm
 * consumers get, mangling included), in plain Node: no DOM, no React, no JSDOM.
 * Run: sh scripts/verify-headless/run.sh
 *
 * What it locks (the "supported headless surface" contract in the public
 * d.ts, plus dist/runtime agreement — see types/index.d.ts EditorStore docs):
 *
 *   1. EXPORTS — EditorStore is a constructible value export; the
 *      serialization helpers are functions.
 *   2. SURFACE — every member of the supported headless whitelist exists on
 *      a bare-node instance.
 *   3. PRIMITIVES — toMarkdown / resetMD / insertText / replaceText /
 *      replaceRanges / getTitle work without a DOM.
 *   3b. SELECTION — setSelection places a model caret/selection with no DOM:
 *      the snapshot reflects it immediately (span anchors included),
 *      subscribeCursorChange fires exactly once, failures report the
 *      documented reason and leave the cursor alone, and insertText types
 *      over the selection chunk by chunk.
 *   4. SYNC SEAM — dual-store convergence: seed via getRenderDataSnapshot →
 *      applyExternalRenderData, edit on one side, ship ops via
 *      subscribeRenderDataOps → applyExternalRenderDataOps, both sides'
 *      toMarkdown() converge. Echo prevention: external application emits no
 *      ops of its own.
 *   5. CHUNKED LOAD — a >500-line initMd finishes loading in Node (the
 *      scheduler falls back from requestIdleCallback to setTimeout), and
 *      resetMD / applyExternalRenderData CANCEL a pending chunked load
 *      (new-baseline semantics; regression guard for the stale-tick
 *      pollution bug fixed in 0.8.2).
 *   6. DEGRADED DOM MEMBERS — getSelectionState returns the documented
 *      no-cursor shape instead of throwing.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const distEntry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../dist/index.cjs",
);

let passes = 0;
let failures = 0;
const check = (name, cond, detail) => {
    if (cond) {
        passes += 1;
    } else {
        failures += 1;
        console.error(`FAIL: ${name}`);
        if (detail !== undefined) console.error("      ", detail);
    }
};

const settle = async (fn, { timeout = 5000, quiet = 3 } = {}) => {
    // Resolve once fn() returns the same value `quiet` polls in a row.
    const start = Date.now();
    let last = fn();
    let stable = 0;
    while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 25));
        const cur = fn();
        stable = cur === last ? stable + 1 : 0;
        last = cur;
        if (stable >= quiet) return cur;
    }
    return last;
};

// ---- 0. environment guard: this must be bare node -------------------------
check("bare node: no document", typeof document === "undefined");
check("bare node: no window", typeof window === "undefined");
check(
    "bare node: no requestAnimationFrame",
    typeof requestAnimationFrame === "undefined",
);

// Silence kernel debug noise; keep our own reporting.
const rawLog = console.log.bind(console);
console.log = () => {};
console.time = () => {};
console.timeEnd = () => {};

const core = require(distEntry);

// ---- 1. exports -----------------------------------------------------------
check("export: EditorStore is a function", typeof core.EditorStore === "function");
for (const name of [
    "serializeRenderData",
    "deserializeRenderData",
    "diffRenderData",
    "toMarkdown",
    "defaultInlineRules",
]) {
    check(`export: ${name} present`, core[name] !== undefined);
}

// ---- 2. construction + surface whitelist ----------------------------------
const { EditorStore } = core;
const store = new EditorStore({
    editable: true,
    initMd: "# Title\n\nhello **world**",
});
const HEADLESS_SURFACE = [
    "toMarkdown",
    "resetMD",
    "insertText",
    "replaceText",
    "replaceRanges",
    "setSelection",
    "getTitle",
    "subscribeRenderDataOps",
    "getRenderDataSnapshot",
    "applyExternalRenderData",
    "applyExternalRenderDataOps",
    "flushPendingInput",
    "getCursorSnapshot",
    "subscribeCursorChange",
];
for (const member of HEADLESS_SURFACE) {
    check(`surface: ${member} is a function`, typeof store[member] === "function");
}

// ---- 3. document primitives ----------------------------------------------
check("primitive: toMarkdown includes source", store.toMarkdown().includes("hello **world**"));
check("primitive: getTitle strips syntax", store.getTitle() === "Title");

store.resetMD("alpha\n\nbeta\n\ngamma");
check("primitive: resetMD replaces the doc", store.toMarkdown().startsWith("alpha"));

const rt = store.replaceText({ search: "beta", replace: "BETA" });
check("primitive: replaceText succeeds", rt.applied === 1 && rt.failed === 0, rt);
check("primitive: replaceText applied", store.toMarkdown().includes("BETA"));

const before = store.toMarkdown();
store.insertText(" tail");
check("primitive: insertText changes the doc", store.toMarkdown() !== before);

// flushPendingInput must be a successful no-op headless when nothing is
// pending: callers may safely proceed with snapshots / remote merges.
check(
    "primitive: flushPendingInput no-op succeeds",
    (await store.flushPendingInput()) === undefined,
);

// ---- 3b. setSelection: model caret placement without a DOM ----------------
const selStore = new EditorStore({
    editable: true,
    initMd: "# Report\n\nThe quick brown fox jumps over it.\n\n- alpha\n- alpha",
});
const selDoc = selStore.toMarkdown();
const selEvents = [];
const unsubSel = selStore.subscribeCursorChange((c) => selEvents.push(c));

const placed = selStore.setSelection({ search: "quick brown fox" });
check(
    "selection: search target applies",
    placed.applied === true &&
        placed.start === selDoc.indexOf("quick brown fox") &&
        placed.end === placed.start + "quick brown fox".length,
    placed,
);
const placedSnap = selStore.getCursorSnapshot();
check(
    "selection: snapshot reflects it immediately",
    !!placedSnap.start && !!placedSnap.end,
    placedSnap,
);
check(
    "selection: snapshot carries span anchors",
    typeof placedSnap.start?.spanUuid === "string" &&
        typeof placedSnap.start?.spanOffset === "number" &&
        typeof placedSnap.end?.spanUuid === "string" &&
        typeof placedSnap.end?.spanOffset === "number",
    placedSnap,
);
check("selection: cursor event fired exactly once", selEvents.length === 1, {
    fired: selEvents.length,
});
check(
    "selection: event value equals the snapshot",
    JSON.stringify(selEvents[0]) === JSON.stringify(placedSnap),
    { event: selEvents[0], snapshot: placedSnap },
);
check(
    "selection: getSelectionState reports the exact needle",
    selStore.getSelectionState().selected_text === "quick brown fox",
    selStore.getSelectionState(),
);
unsubSel();

// Failure paths: documented reason, cursor untouched.
const frozen = JSON.stringify(selStore.getCursorSnapshot());
for (const [name, target, reason] of [
    ["not_found", { search: "no such text" }, "not_found"],
    ["ambiguous", { search: "alpha" }, "ambiguous"],
    ["out_of_bounds", { start: 100000 }, "out_of_bounds"],
    ["invalid", { search: "" }, "invalid"],
]) {
    const failed = selStore.setSelection(target);
    check(
        `selection: ${name} reports "${reason}"`,
        failed.applied === false && failed.reason === reason,
        failed,
    );
    check(
        `selection: ${name} leaves the cursor untouched`,
        JSON.stringify(selStore.getCursorSnapshot()) === frozen,
    );
}

// Type-over: chunk-by-chunk insertText replaces the selection.
for (const chunk of ["lazy ", "amber ", "vulpine"]) selStore.insertText(chunk);
check(
    "selection: chunked insertText replaces the selection",
    selStore.toMarkdown() ===
        selDoc.slice(0, placed.start) +
            "lazy amber vulpine" +
            selDoc.slice(placed.end),
    selStore.toMarkdown(),
);

// Collapsed placement inserts without deleting.
const collapsed = selStore.setSelection({ search: "Report", collapse: "end" });
check("selection: collapse end applies", collapsed.applied === true, collapsed);
check(
    "selection: collapsed snapshot has null end",
    selStore.getCursorSnapshot().end === null,
    selStore.getCursorSnapshot(),
);
selStore.insertText(" v2");
check(
    "selection: collapsed insert lands at the match tail",
    selStore.toMarkdown().startsWith("# Report v2\n"),
    selStore.toMarkdown().slice(0, 20),
);

// ---- 4. sync seam: dual-store convergence ---------------------------------
const user = new EditorStore({
    editable: true,
    initMd: "# Doc\n\nshared state line\n\n- item one\n- item two",
});
const agent = new EditorStore({ editable: true, initMd: "" });
agent.applyExternalRenderData(user.getRenderDataSnapshot());
check("sync: seed converges", agent.toMarkdown() === user.toMarkdown());

const shipped = [];
const unsubAgent = agent.subscribeRenderDataOps((ops) => shipped.push(...ops));
let userEchoOps = 0;
const unsubUser = user.subscribeRenderDataOps(() => (userEchoOps += 1));

const agentEdit = agent.replaceText({
    search: "shared state line",
    replace: "edited by the agent",
});
check(
    "sync: agent edit succeeds",
    agentEdit.applied === 1 && agentEdit.failed === 0,
    agentEdit,
);
check("sync: ops were emitted", shipped.length > 0);

user.applyExternalRenderDataOps(shipped.splice(0));
check("sync: dual-store convergence", user.toMarkdown() === agent.toMarkdown(), {
    user: user.toMarkdown(),
    agent: agent.toMarkdown(),
});
check("sync: external application emits no echo ops", userEchoOps === 0);
unsubAgent();
unsubUser();

// ---- 5. chunked load in node ----------------------------------------------
const BIG_LINES = 1200;
const bigMd = Array.from({ length: BIG_LINES }, (_, i) => `line ${i}`).join("\n");
const reference = new EditorStore({ editable: true, initMd: "" });
reference.resetMD(bigMd); // sync full parse = canonical form of the big doc
const referenceMd = reference.toMarkdown();

const chunked = new EditorStore({ editable: true, initMd: bigMd });
const initialLineCount = chunked.toMarkdown().split("\n").length;
check(
    "chunked: constructor parses only the first chunk synchronously",
    initialLineCount < BIG_LINES,
    { initialLineCount },
);
const settled = await settle(() => chunked.toMarkdown());
check("chunked: async append completes in node", settled === referenceMd, {
    settledLines: settled.split("\n").length,
    referenceLines: referenceMd.split("\n").length,
});

// resetMDChunked keeps working after the generation-capture reorder.
const rechunked = new EditorStore({ editable: true, initMd: "" });
rechunked.resetMDChunked?.(bigMd);
if (typeof rechunked.resetMDChunked === "function") {
    const rcSettled = await settle(() => rechunked.toMarkdown());
    check("chunked: resetMDChunked completes in node", rcSettled === referenceMd);
}

// ---- 5b. new-baseline cancellation (0.8.2 regression guard) ---------------
// applyExternalRenderData while a chunked load is pending must cancel it.
const seedSource = new EditorStore({ editable: true, initMd: "seed doc" });
const seeded = new EditorStore({ editable: true, initMd: bigMd });
seeded.applyExternalRenderData(seedSource.getRenderDataSnapshot());
const seededSettled = await settle(() => seeded.toMarkdown());
check(
    "baseline: applyExternalRenderData cancels pending chunked append",
    seededSettled === seedSource.toMarkdown(),
    { settled: seededSettled.slice(0, 80) },
);

// resetMD while a chunked load is pending must cancel it too.
const resetTarget = new EditorStore({ editable: true, initMd: bigMd });
resetTarget.resetMD("fresh doc");
const resetSettled = await settle(() => resetTarget.toMarkdown());
check(
    "baseline: resetMD cancels pending chunked append",
    resetSettled === "fresh doc",
    { settled: resetSettled.slice(0, 80) },
);

// ---- 6. degraded DOM-flavoured members ------------------------------------
const sel = store.getSelectionState();
check(
    "degraded: getSelectionState returns the no-cursor shape",
    sel && sel.has_selection === false && typeof sel.after === "string",
    sel,
);
// A fresh store has no cursor; edits place a model caret (same as typing),
// so the null/null shape is only guaranteed before the first edit.
const pristine = new EditorStore({ editable: true, initMd: "untouched" });
const cursor = pristine.getCursorSnapshot();
check(
    "degraded: getCursorSnapshot is null/null before any edit",
    cursor && cursor.start === null && cursor.end === null,
    cursor,
);

// ---- report ---------------------------------------------------------------
rawLog(`\nverify-headless: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
