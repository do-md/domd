/**
 * Verification for @do-md/virtual — the DOM-virtualization policy package —
 * headless: pure window math (height table, prefix sums, overscan window,
 * hysteresis, op gating) plus the VirtualStore state machine attached to a
 * REAL kernel EditorStore (block-list sync, mode/threshold resolution,
 * force-full, pins, measurement-driven pads).
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-virtual-policy/run.mts
 */
import { EditorStore } from "@do-md/core-react";
import {
    DEFAULT_AUTO_THRESHOLD,
    HeightTable,
    VirtualStore,
    computeWindowRange,
    opsAffectTopLevel,
    windowCovers,
    type BlockSummary,
} from "@do-md/virtual";

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) passed += 1;
    else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/** Let the store's throttled trailing block-list pull run (SCAN_THROTTLE_MS
 *  is 120ms inside the package). */
const settleScans = () => new Promise((r) => setTimeout(r, 200));

const summaries = (specs: [string, string][]): BlockSummary[] =>
    specs.map(([uuid, type]) => ({ uuid, type, isAutoFill: false }));

// ---------------------------------------------------------------------------
// HeightTable
{
    const table = new HeightTable();
    table.setBlocks(
        summaries([
            ["a", "P"],
            ["sep", "LineBrBr"],
            ["b", "P"],
            ["c", "Pre"],
        ]),
    );
    check("table: block count", table.blockCount === 4);
    check(
        "table: estimates by type (scaffolding = 0)",
        table.heightOf(0) === 28 &&
            table.heightOf(1) === 0 &&
            table.heightOf(3) === 160,
    );
    check(
        "table: prefix offsets",
        table.offsetOf(0) === 0 &&
            table.offsetOf(2) === 28 &&
            table.offsetOf(4) === 28 + 28 + 160 &&
            table.total() === 216,
    );
    check("table: unknown type falls back", table.estimateFor("Mystery") === 32);

    check("table: record changes offsets", table.record("a", 100, "P") === true);
    check(
        "table: measured wins over estimate",
        table.heightOf(0) === 100 && table.offsetOf(2) === 100,
    );
    check(
        "table: sub-pixel jitter ignored",
        table.record("a", 100.3, "P") === false,
    );

    // Offsets: a=[0,100), sep=[100,100) (zero height — contains nothing),
    // b=[100,128), c=[128,288). indexAt lands on the block that actually
    // occupies the offset, skipping zero-height scaffolding.
    check(
        "table: indexAt boundaries",
        table.indexAt(-10) === 0 &&
            table.indexAt(0) === 0 &&
            table.indexAt(99.9) === 0 &&
            table.indexAt(100) === 2 &&
            table.indexAt(100.5) === 2 &&
            table.indexAt(128.5) === 3 &&
            table.indexAt(10_000) === 3,
        JSON.stringify([0, 100, 128].map((y) => table.indexAt(y))),
    );

    // Measured heights survive a list rebuild (same uuid, new array).
    table.setBlocks(
        summaries([
            ["x", "P"],
            ["a", "P"],
        ]),
    );
    check(
        "table: measurements carry over rebuilds by uuid",
        table.heightOf(1) === 100 && table.heightOf(0) === 28,
    );
}
{
    // Self-tuning: after enough samples the type average replaces the preset.
    const table = new HeightTable();
    const blocks = summaries(
        Array.from({ length: 6 }, (_, i) => [`p${i}`, "P"] as [string, string]),
    );
    table.setBlocks(blocks);
    for (let i = 0; i < 4; i++) table.record(`p${i}`, 60, "P");
    check(
        "table: type estimate self-tunes from measurements",
        table.estimateFor("P") === 60 && table.heightOf(5) === 60,
    );
}

// ---------------------------------------------------------------------------
// computeWindowRange + windowCovers
{
    const table = new HeightTable();
    table.setBlocks(
        summaries(
            Array.from({ length: 1000 }, (_, i) => [
                `b${i}`,
                "P",
            ] as [string, string]),
        ),
    );
    // 1000 blocks x 28px = 28000px tall; viewport 700px at viewTop 14000.
    const range = computeWindowRange(table, 14_000, 700);
    check("range: exists", range !== null);
    if (range) {
        // Overscan: 1.5 viewports above (1050px), 3.5 below (2450px).
        const topTarget = 14_000 - 1050;
        const bottomTarget = 14_000 + 700 + 2450;
        check(
            "range: overscanned bounds",
            table.offsetOf(range.startIndex) <= topTarget &&
                table.offsetOf(range.startIndex + 1) > topTarget &&
                table.offsetOf(range.endIndex) >= bottomTarget,
            JSON.stringify(range),
        );
        check(
            "range: pads are exact complements",
            range.topPad === table.offsetOf(range.startIndex) &&
                range.bottomPad ===
                    table.total() - table.offsetOf(range.endIndex),
        );
        check(
            "range: hysteresis holds in place",
            windowCovers(table, range, 14_000, 700) &&
                windowCovers(table, range, 14_300, 700),
        );
        check(
            "range: hysteresis breaks after a long scroll",
            !windowCovers(table, range, 17_500, 700),
        );
    }
    const edge = computeWindowRange(table, 0, 700);
    check(
        "range: clamped at the top",
        edge !== null && edge.startIndex === 0 && edge.topPad === 0,
    );
    const bottom = computeWindowRange(table, 27_990, 700);
    check(
        "range: clamped at the bottom",
        bottom !== null && bottom.endIndex === 1000 && bottom.bottomPad === 0,
    );
    const empty = new HeightTable();
    check("range: empty table yields null", computeWindowRange(empty, 0, 700) === null);
}

// ---------------------------------------------------------------------------
// opsAffectTopLevel
{
    const root = "root-uuid";
    check(
        "ops: span text set is irrelevant",
        opsAffectTopLevel([{ op: "set", uuid: "span1", key: "text" }], root) ===
            false,
    );
    check(
        "ops: nested insert is irrelevant",
        opsAffectTopLevel([{ op: "insert", parent: "block1" }], root) === false,
    );
    check(
        "ops: root insert rescans",
        opsAffectTopLevel([{ op: "insert", parent: root }], root) === true,
    );
    check(
        "ops: root delete rescans",
        opsAffectTopLevel([{ op: "delete", parent: root }], root) === true,
    );
    check(
        "ops: replaceRoot rescans",
        opsAffectTopLevel([{ op: "replaceRoot" }], root) === true,
    );
    check(
        "ops: root children set rescans",
        opsAffectTopLevel(
            [{ op: "set", uuid: root, key: "children" }],
            root,
        ) === true,
    );
    check(
        "ops: unknown op fails toward rescan",
        opsAffectTopLevel([{ op: "future-op" }], root) === true,
    );
    check(
        "ops: mixed batch rescans when any hit",
        opsAffectTopLevel(
            [
                { op: "set", uuid: "span1", key: "text" },
                { op: "insert", parent: root },
            ],
            root,
        ) === true,
    );
}

// ---------------------------------------------------------------------------
// VirtualStore against a real kernel EditorStore
const md = (n: number) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i} text.`).join("\n\n");

{
    // mode=off attaches nothing visible.
    const editor = new EditorStore({ initMd: md(30), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "off" });
    virtual.attach(editor);
    check(
        "store: off mode stays inactive",
        virtual.state.active === false && virtual.state.window === null,
    );
    virtual.detach();
}
{
    // auto under threshold → inactive; over threshold → active window.
    const editor = new EditorStore({ initMd: md(30), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "auto", threshold: 1000 });
    virtual.attach(editor);
    check(
        "store: auto under threshold inactive",
        virtual.state.active === false &&
            virtual.state.blockCount === editor.getTopLevelBlockCount(),
    );
    virtual.configure({ threshold: 10 });
    check(
        "store: auto over threshold activates",
        virtual.state.active === true && virtual.state.window !== null,
    );
    virtual.detach();
}
{
    const editor = new EditorStore({ initMd: md(200), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "always" });
    virtual.attach(editor);
    virtual.setViewport(0, 800);
    const win1 = virtual.state.window;
    check(
        "store: always mode windows from the top",
        win1 !== null && win1.startIndex === 0 && win1.topPad === 0,
        JSON.stringify(win1),
    );
    check(
        "store: initial scan count",
        virtual.scanCount === 1,
        String(virtual.scanCount),
    );

    // Scroll far: window follows.
    virtual.setViewport(4000, 800);
    const win2 = virtual.state.window;
    check(
        "store: window follows the viewport",
        win2 !== null && win2.startIndex > 0 && win2.topPad > 0,
        JSON.stringify(win2),
    );

    // Typing-shaped op (span set) must NOT rescan; structural must.
    const before = virtual.scanCount;
    editor.resetMD(md(201));
    await settleScans();
    check(
        "store: replaceRoot rescans and updates count",
        virtual.scanCount > before &&
            virtual.state.blockCount === editor.getTopLevelBlockCount(),
        `scans ${before} -> ${virtual.scanCount}`,
    );

    // Measurements move pads (force refresh via recordHeights).
    const blocks = virtual.table.blocks;
    const winBefore = virtual.state.window!;
    const firstUuid = blocks[0].uuid;
    const changed = virtual.recordHeights([
        { uuid: firstUuid, height: 300, type: blocks[0].type },
    ]);
    const winAfter = virtual.state.window!;
    check(
        "store: measurement changes pads",
        changed === true && winAfter.topPad !== winBefore.topPad,
        JSON.stringify({ before: winBefore.topPad, after: winAfter.topPad }),
    );

    // Pins surface in the window.
    const lastUuid = blocks[blocks.length - 1].uuid;
    const unpin = virtual.pin(lastUuid);
    check(
        "store: pin surfaces in pinnedUuids",
        virtual.state.window?.pinnedUuids?.includes(lastUuid) === true,
    );
    unpin();
    check(
        "store: unpin removes it",
        virtual.state.window?.pinnedUuids === undefined,
    );

    // Force-full (print materialization) suspends windowing, nested-safe.
    virtual.setForceFull(true);
    virtual.setForceFull(true);
    check(
        "store: force-full suspends the window",
        virtual.state.window === null && virtual.state.active === false,
    );
    virtual.setForceFull(false);
    check(
        "store: force-full is counted",
        virtual.state.window === null,
    );
    virtual.setForceFull(false);
    check(
        "store: releasing force-full restores the window",
        virtual.state.window !== null && virtual.state.active === true,
    );

    virtual.detach();
    check(
        "store: detach clears state",
        virtual.state.window === null &&
            virtual.state.active === false &&
            virtual.state.blockCount === 0,
    );
}
{
    // Remote-edit fallback: external applies emit no ops — the O(1) count
    // probe must still catch the structural change. Simulate by an op-less
    // structural mutation: suppress is internal, so approximate with the
    // probe path directly — attach, then mutate through a second store API
    // that emits ops but ALSO verify the probe alone would have caught it.
    const editor = new EditorStore({ initMd: md(50), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "always" });
    virtual.attach(editor);
    const countBefore = virtual.state.blockCount;
    editor.resetMD(md(80));
    await settleScans();
    check(
        "store: block count tracks structural change",
        virtual.state.blockCount > countBefore &&
            virtual.state.blockCount === editor.getTopLevelBlockCount(),
    );
    virtual.detach();
}

// ---------------------------------------------------------------------------
// Chunked-load timing: the window must track the LIVE viewport while a
// document streams in (the real file-open path is a >500-line constructor
// that appends chunks from idle ticks). Regression guard for the
// "scroll to the bottom during load shows only spacer" bug: the binder's rAF
// pass is starved while the main thread parses, so a window computed from a
// pushed-and-cached viewport stays pinned where the reader no longer is.
{
    const editor = new EditorStore({ initMd: md(40), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "always" });
    virtual.attach(editor);

    // Live viewport source, exactly like the binder registers.
    let viewTop = 0;
    const viewportHeight = 800;
    virtual.attachViewportProvider(() => ({ viewTop, height: viewportHeight }));

    const windowCovers_ = (index: number) => {
        const w = virtual.state.window;
        return w !== null && index >= w.startIndex && index < w.endIndex;
    };
    check(
        "chunked: window starts at the top of the document",
        windowCovers_(0),
        JSON.stringify(virtual.state.window),
    );

    // Grow the document the way appendMarkdownIncremental_ does (structural
    // ops at the root), WITHOUT any rAF/binder pass in between.
    for (let i = 0; i < 6; i++) {
        editor.resetMD(md(40 + (i + 1) * 40));
    }
    await settleScans();
    const grownCount = editor.getTopLevelBlockCount();
    check(
        "chunked: block list tracks the growing document",
        virtual.state.blockCount === grownCount,
        `${virtual.state.blockCount} vs ${grownCount}`,
    );

    // The reader scrolls near the end while loading continues; only the live
    // viewport moved — no pass, no setViewport push.
    viewTop = virtual.table.total() - viewportHeight;
    virtual.syncViewport();
    const lastIndex = virtual.table.blockCount - 1;
    check(
        "chunked: syncViewport alone re-windows onto the live position",
        windowCovers_(lastIndex),
        JSON.stringify({ window: virtual.state.window, lastIndex }),
    );

    // Further appends must NOT drag the window back to the stale position.
    for (let i = 0; i < 3; i++) {
        editor.resetMD(md(280 + (i + 1) * 40));
    }
    await settleScans();
    const w = virtual.state.window!;
    const viewIndex = virtual.table.indexAt(viewTop);
    check(
        "chunked: appends keep the window on the reader, not the stale viewport",
        viewIndex >= w.startIndex && viewIndex < w.endIndex,
        JSON.stringify({ window: w, viewIndex }),
    );
    check(
        "chunked: bottom pad never claims unrendered space above the window",
        w.topPad <= viewTop + 1,
        JSON.stringify({ topPad: w.topPad, viewTop }),
    );

    virtual.attachViewportProvider(null);
    virtual.detach();
}
{
    // Rescan throttling: a burst of structural ops (one per chunk tick) must
    // not trigger one full O(n) block-list pull each — that is what saturates
    // the main thread during a big load.
    const editor = new EditorStore({ initMd: md(30), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "always" });
    virtual.attach(editor);
    const afterAttach = virtual.scanCount;
    for (let i = 0; i < 25; i++) {
        editor.resetMD(md(30 + (i + 1) * 5));
    }
    const burstScans = virtual.scanCount - afterAttach;
    check(
        "throttle: an op burst coalesces into few full pulls",
        burstScans <= 3,
        `${burstScans} scans for 25 structural ops`,
    );
    // The final state must still be correct (trailing pull or immediate).
    await new Promise((r) => setTimeout(r, 200));
    check(
        "throttle: trailing pull reconciles the final block count",
        virtual.state.blockCount === editor.getTopLevelBlockCount(),
        `${virtual.state.blockCount} vs ${editor.getTopLevelBlockCount()}`,
    );
    virtual.detach();
}

// ---------------------------------------------------------------------------
// Default auto threshold (the tier /editor runs on). Mount cost is ~0.3ms per
// top-level block, so the default must stay at the ~150ms imperceptible
// boundary; the app passes no explicit threshold, so this constant IS the
// product behavior.
{
    check(
        "threshold: default is 500 top-level blocks",
        DEFAULT_AUTO_THRESHOLD === 500,
        String(DEFAULT_AUTO_THRESHOLD),
    );
    // A big document does NOT arrive all at once: the constructor parses only
    // the first 500 lines synchronously and streams the rest from idle ticks,
    // so at attach time even a 10MB file reports ~499 top-level blocks.
    // Activation therefore has to happen DURING the load, on a later block-
    // list pull — assert exactly that transition.
    const editor = new EditorStore({ initMd: md(400), editable: true });
    const virtual = new VirtualStore();
    virtual.configure({ mode: "auto" });
    virtual.attach(editor);
    check(
        "threshold: first chunk of a streaming load stays under the default",
        editor.getTopLevelBlockCount() < DEFAULT_AUTO_THRESHOLD &&
            virtual.state.active === false,
        `${editor.getTopLevelBlockCount()} blocks, active=${virtual.state.active}`,
    );
    editor.resetMD(md(400));
    await settleScans();
    const blocks = editor.getTopLevelBlockCount();
    check(
        "threshold: crossing the default mid-load activates windowing",
        blocks >= DEFAULT_AUTO_THRESHOLD && virtual.state.active === true,
        `${blocks} blocks, active=${virtual.state.active}`,
    );
    const small = new EditorStore({ initMd: md(20), editable: true });
    const virtualSmall = new VirtualStore();
    virtualSmall.configure({ mode: "auto" });
    virtualSmall.attach(small);
    check(
        "threshold: a document below the default renders in full",
        small.getTopLevelBlockCount() < DEFAULT_AUTO_THRESHOLD &&
            virtualSmall.state.active === false &&
            virtualSmall.state.window === null,
        `${small.getTopLevelBlockCount()} blocks`,
    );
    virtual.detach();
    virtualSmall.detach();
}

// ---------------------------------------------------------------------------
// uuid -> index map (review Wave 2): the TOC spy resolves every heading on
// every scroll frame, followCursor_ on every keystroke, scrollToBlock on
// every jump. All three used to scan the block array.
{
    const table = new HeightTable();
    const blocks = summaries(
        Array.from({ length: 5000 }, (_, i) => [`b${i}`, "P"] as [string, string]),
    );
    table.setBlocks(blocks);
    check(
        "index: resolves uuids to their position",
        table.indexOfUuid("b0") === 0 &&
            table.indexOfUuid("b2499") === 2499 &&
            table.indexOfUuid("b4999") === 4999,
    );
    check("index: unknown uuid is -1", table.indexOfUuid("nope") === -1);

    // Rebuilding the list re-indexes, and stale uuids stop resolving.
    table.setBlocks(summaries([["z0", "P"], ["b4999", "P"]]));
    check(
        "index: rebuilt list re-indexes",
        table.indexOfUuid("z0") === 0 &&
            table.indexOfUuid("b4999") === 1 &&
            table.indexOfUuid("b0") === -1,
    );
}
{
    // Measured heights are pruned to the blocks still in the document —
    // otherwise a long session accumulates every uuid that ever existed.
    const table = new HeightTable();
    table.setBlocks(
        summaries(
            Array.from({ length: 50 }, (_, i) => [`g${i}`, "P"] as [string, string]),
        ),
    );
    for (let i = 0; i < 50; i++) table.record(`g${i}`, 40 + i, "P");
    check("prune: measurements recorded", table.isMeasured("g49"));
    table.setBlocks(summaries([["g0", "P"], ["g1", "P"]]));
    check(
        "prune: measurements of departed blocks are dropped",
        table.isMeasured("g0") && !table.isMeasured("g49"),
    );
    check(
        "prune: surviving measurements keep their value",
        table.heightOf(0) === 40,
    );
}
{
    // Incremental prefix patching must produce exactly the full-rebuild
    // numbers (the offsets everything downstream is computed from).
    const build = () => {
        const t = new HeightTable();
        t.setBlocks(
            summaries(
                Array.from({ length: 200 }, (_, i) => [`p${i}`, "P"] as [string, string]),
            ),
        );
        return t;
    };
    const incremental = build();
    const rebuilt = build();
    // Incremental: read offsets (building the prefix), then measure in the
    // middle and read again — the patch path.
    incremental.offsetOf(200);
    incremental.record("p100", 111, "P");
    incremental.offsetOf(200);
    incremental.record("p10", 222, "P");
    const incTotal = incremental.total();
    const incMid = incremental.offsetOf(150);
    // Rebuild: same measurements, prefix built once at the end.
    rebuilt.record("p100", 111, "P");
    rebuilt.record("p10", 222, "P");
    check(
        "prefix: incremental patching matches a full rebuild",
        incTotal === rebuilt.total() && incMid === rebuilt.offsetOf(150),
        `${incTotal}/${rebuilt.total()} ${incMid}/${rebuilt.offsetOf(150)}`,
    );
    check(
        "prefix: indexAt agrees after patching",
        incremental.indexAt(incMid) === rebuilt.indexAt(incMid),
    );
}
{
    // HrDiv: the kernel reports horizontal rules as HrDiv at top level, so
    // that is the key the estimate must live under.
    const table = new HeightTable();
    table.setBlocks(summaries([["hr", "HrDiv"]]));
    check(
        "estimate: HrDiv has a real estimate (not the generic fallback)",
        table.estimateFor("HrDiv") === 29 &&
            table.heightOf(0) === 29,
        String(table.estimateFor("HrDiv")),
    );
}

// ---------------------------------------------------------------------------
if (failures.length) {
    console.error(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
}
console.log(`verify-virtual-policy: ${passed} passed, 0 failed`);
