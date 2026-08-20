/**
 * Headless assertion matrix for the batch replace API
 * (EditorStore.replaceRanges / replaceText). Run: sh scripts/verify-replace/run.sh
 *
 * Instantiates the REAL EditorStore (no DOM is touched on these paths) and
 * asserts, per scenario:
 *
 *   1. TEXT FAITHFULNESS — after the batch, store.toMarkdown() equals a plain
 *      string-splice reference implementation applied to the pristine
 *      serialization. This is the defining invariant of the API.
 *   2. CANONICALITY — the resulting tree serializes block-per-block like a
 *      fresh parse of the resulting text (top-level [type, text] shape), so
 *      scoped reparses never weld or mis-split blocks at slice boundaries.
 *   3. IDENTITY — untouched top-level children keep reference equality;
 *      a same-type edited block keeps its uuid (mergeParsedBlock path).
 *   4. OP STREAM — every change reaches subscribers as fine-grained
 *      RenderDataOps (never replaceRoot); replaying the captured ops onto a
 *      pristine snapshot converges to the same markdown (collab proxy).
 *   5. UNDO — one batch = one undo step.
 */
import { EditorStore } from "../../src/editor/store";
import {
    RangeEdit,
    TextEdit,
} from "../../src/editor/model/replace/plan";
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { splitTextSpans } from "../../src/data-parse/postprocess/splitTextSpans";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import {
    deserializeRenderData,
    applyRenderDataOpsToDraft,
    RenderDataOp,
    SerializedRenderData,
} from "../../src/editor/model/sync/renderDataOps";
import { ParentRenderData, RenderData } from "../../src/editor/type";
import { produce } from "immer";

// Silence kernel debug noise; keep our own reporting on stderr/stdout.
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
        rawLog(
            `✗ ${name}`,
            detail !== undefined ? JSON.stringify(detail) : "",
        );
    }
};

type AnyNode = ParentRenderData | RenderData;

/** Reference implementation: apply range edits to a plain string. */
const spliceAll = (text: string, edits: RangeEdit[]): string => {
    const sorted = edits
        .map((e, i) => ({ ...e, i }))
        .sort((a, b) => a.start - b.start || a.i - b.i);
    for (let k = sorted.length - 1; k >= 0; k -= 1) {
        const e = sorted[k];
        text = text.slice(0, e.start) + e.text + text.slice(e.end);
    }
    return text;
};

/** Top-level [type, serializedText] shape — span layout intentionally ignored. */
const topLevelShape = (root: AnyNode): [string, string][] =>
    (root.children_ || []).map((c) => [
        String(c.htmlType_),
        toMarkdown(c) || "",
    ]);

const freshParse = (md: string) => {
    const tree = parseMarkdown(md);
    splitTextSpans(tree);
    return tree;
};

const makeStore = (initMd: string) =>
    new EditorStore({ editable: true, initMd });

/** Serialize-shape equality that tolerates the trailing autofill EmptyP the
 *  store appends (it serializes to "" and a fresh parse may not have it). */
const shapesMatch = (a: [string, string][], b: [string, string][]) => {
    const strip = (s: [string, string][]) =>
        s.filter(([, text], i) => !(i === s.length - 1 && text === ""));
    const sa = strip(a);
    const sb = strip(b);
    if (sa.length !== sb.length) return false;
    return sa.every(([t, x], i) => sb[i][0] === t && sb[i][1] === x);
};

interface Scenario {
    name: string;
    initMd: string;
    edits: (md: string) => RangeEdit[];
    /** Skip the canonical-shape assertion (documented divergence). */
    skipShape?: boolean;
}

const at = (md: string, needle: string, occurrence = 0): number => {
    let idx = -1;
    for (let k = 0; k <= occurrence; k += 1) {
        idx = md.indexOf(needle, idx + 1);
        if (idx === -1) throw new Error(`needle not found: ${needle}`);
    }
    return idx;
};

const range = (
    md: string,
    needle: string,
    text: string,
    occurrence = 0,
): RangeEdit => {
    const start = at(md, needle, occurrence);
    return { start, end: start + needle.length, text };
};

const PARA_DOC = "Alpha beta gamma.\n\nSecond paragraph here.\n\nThird one ends it.";
const HEADER_DOC = "# Title\n\nIntro paragraph text.\n\n## Section\n\nBody of the section.";
const LIST_DOC = "- item one\n- item two\n- item three";
const OL_DOC = "1. first entry\n2. second entry";
const CODE_DOC = "```js\nconst a = 1;\nconst b = 2;\n```";
const QUOTE_DOC = "> quoted line\n> more quote";
const IMG_DOC = "before ![alt](http://x/y.png) after";
const MARKS_DOC = "some **bold** and *italic* and ==hl== text";
const TABLE_DOC = "| aa | bb |\n| --- | --- |\n| cc | dd |";
const MIXED_DOC = `# Doc\n\nFirst para with **bold** text.\n\n- l1\n- l2\n\n\`\`\`py\nx = 1\n\`\`\`\n\nLast para.`;

const scenarios: Scenario[] = [
    {
        name: "para: single replacement",
        initMd: PARA_DOC,
        edits: (md) => [range(md, "beta", "BETA")],
    },
    {
        name: "para: grow then later edit (anchor stability)",
        initMd: PARA_DOC,
        edits: (md) => [
            range(md, "beta", "a-much-longer-run"),
            range(md, "paragraph", "PARAGRAPH"),
        ],
    },
    {
        name: "para: shrink then later edit",
        initMd: PARA_DOC,
        edits: (md) => [
            range(md, "Alpha beta", "A"),
            range(md, "Third", "THIRD"),
        ],
    },
    {
        name: "para: two edits in the same block",
        initMd: PARA_DOC,
        edits: (md) => [
            range(md, "Alpha", "The-very-first"),
            range(md, "gamma", "g"),
        ],
    },
    {
        name: "para: pure insertion at doc start",
        initMd: PARA_DOC,
        edits: () => [{ start: 0, end: 0, text: "Zero " }],
    },
    {
        name: "para: pure insertion at doc end",
        initMd: PARA_DOC,
        edits: (md) => [{ start: md.length, end: md.length, text: " Tail." }],
    },
    {
        name: "para: append new paragraph at doc end",
        initMd: PARA_DOC,
        edits: (md) => [
            { start: md.length, end: md.length, text: "\n\nFourth paragraph." },
        ],
    },
    {
        name: "para: insertion at block boundary (end of first para)",
        initMd: PARA_DOC,
        edits: (md) => [
            {
                start: at(md, "gamma.") + "gamma.".length,
                end: at(md, "gamma.") + "gamma.".length,
                text: " Appended.",
            },
        ],
    },
    {
        name: "para: insert new block between paragraphs (before next block)",
        initMd: PARA_DOC,
        edits: (md) => [
            { start: at(md, "Second"), end: at(md, "Second"), text: "Inserted middle.\n\n" },
        ],
    },
    {
        name: "para: pure deletion inside block",
        initMd: PARA_DOC,
        edits: (md) => [range(md, " beta", "")],
    },
    {
        name: "para: cross-block deletion (spans separator)",
        initMd: PARA_DOC,
        edits: (md) => [
            {
                start: at(md, "gamma."),
                end: at(md, "paragraph"),
                text: "",
            },
        ],
    },
    {
        name: "para: whole block deletion incl leading separator",
        initMd: PARA_DOC,
        edits: (md) => [range(md, "\n\nSecond paragraph here.", "")],
    },
    {
        name: "para: whole block deletion incl trailing separator",
        initMd: PARA_DOC,
        edits: (md) => [range(md, "Second paragraph here.\n\n", "")],
    },
    {
        name: "para: whole block deletion exact (leaves blank line)",
        initMd: PARA_DOC,
        edits: (md) => [range(md, "Second paragraph here.", "")],
    },
    {
        name: "para: replace across separator with new separator",
        initMd: PARA_DOC,
        edits: (md) => [
            range(md, "gamma.\n\nSecond", "gamma!\n\nNEW second"),
        ],
    },
    {
        name: "para: delete entire document",
        initMd: PARA_DOC,
        edits: (md) => [{ start: 0, end: md.length, text: "" }],
    },
    {
        name: "para: replace entire document",
        initMd: PARA_DOC,
        edits: (md) => [
            { start: 0, end: md.length, text: "# Fresh\n\nNew body." },
        ],
    },
    {
        name: "header: edit heading text",
        initMd: HEADER_DOC,
        edits: (md) => [range(md, "Title", "Renamed Title")],
    },
    {
        name: "header: edit into heading marker (scaffolding offsets)",
        initMd: HEADER_DOC,
        edits: (md) => [range(md, "## Section", "### Section")],
    },
    {
        name: "header: demote h1 by editing marker",
        initMd: HEADER_DOC,
        edits: (md) => [range(md, "# Title", "Plain title line")],
    },
    {
        name: "list: edit one item",
        initMd: LIST_DOC,
        edits: (md) => [range(md, "item two", "ITEM 2")],
    },
    {
        name: "list: edit list marker region",
        initMd: LIST_DOC,
        edits: (md) => [range(md, "- item three", "final line, not a list")],
    },
    {
        name: "list: append item",
        initMd: LIST_DOC,
        edits: (md) => [
            { start: md.length, end: md.length, text: "\n- item four" },
        ],
    },
    {
        name: "ol: renumber-safe item edit",
        initMd: OL_DOC,
        edits: (md) => [range(md, "second entry", "2nd entry")],
    },
    {
        name: "code: edit inside fence",
        initMd: CODE_DOC,
        edits: (md) => [range(md, "const a = 1;", "const a = 42;")],
    },
    {
        name: "code: edit fence lang line",
        initMd: CODE_DOC,
        edits: (md) => [range(md, "```js", "```ts")],
    },
    {
        name: "quote: edit quoted text",
        initMd: QUOTE_DOC,
        edits: (md) => [range(md, "quoted line", "QUOTED")],
    },
    {
        name: "image: replace url inside atomic construct",
        initMd: IMG_DOC,
        edits: (md) => [range(md, "http://x/y.png", "http://x/z.jpg")],
    },
    {
        name: "image: partial overlap into atomic construct",
        initMd: IMG_DOC,
        edits: (md) => [range(md, "(http://x/y.png) after", "gone")],
    },
    {
        name: "marks: replace across bold delimiters",
        initMd: MARKS_DOC,
        edits: (md) => [range(md, "**bold** and", "plain and")],
    },
    {
        name: "marks: edit inside highlight",
        initMd: MARKS_DOC,
        edits: (md) => [range(md, "==hl==", "==HL==")],
    },
    {
        name: "table: edit one cell (canonical padding base)",
        initMd: TABLE_DOC,
        edits: (md) => [range(md, "cc", "a-longer-cell")],
    },
    {
        name: "mixed: multi-block batch across shapes",
        initMd: MIXED_DOC,
        edits: (md) => [
            range(md, "Doc", "Document"),
            range(md, "**bold**", "**bolder**"),
            range(md, "- l2", "- l2 edited"),
            range(md, "x = 1", "x = 2"),
            range(md, "Last para.", "Very last para."),
        ],
    },
    {
        name: "empty doc: insertion",
        initMd: "",
        edits: () => [{ start: 0, end: 0, text: "Hello world." }],
    },
    {
        name: "empty doc: insert multi-block",
        initMd: "",
        edits: () => [{ start: 0, end: 0, text: "# T\n\nBody." }],
    },
    {
        name: "unicode: replace across emoji",
        initMd: "before 🎉🎈 after",
        edits: (md) => [range(md, "🎉🎈", "🎃")],
    },
    {
        name: "edge: replacement starting with blank line at block start",
        initMd: PARA_DOC,
        edits: (md) => [
            range(md, "Second paragraph here.", "\n\nPushed down para."),
        ],
    },
    {
        name: "edge: insert blank paragraph between blocks",
        initMd: PARA_DOC,
        edits: (md) => [
            {
                start: at(md, "\n\nSecond"),
                end: at(md, "\n\nSecond"),
                text: "\n\n",
            },
        ],
    },
    {
        name: "edge: delete first block of doc",
        initMd: PARA_DOC,
        edits: (md) => [range(md, "Alpha beta gamma.\n\n", "")],
    },
    {
        name: "edge: delete last block of doc",
        initMd: PARA_DOC,
        edits: (md) => [range(md, "\n\nThird one ends it.", "")],
    },
    {
        name: "edge: two exact whole-block deletions in one batch",
        initMd: "P one.\n\nP two.\n\nP three.\n\nP four.\n\nP five.",
        edits: (md) => [
            range(md, "P two.", ""),
            range(md, "P four.", ""),
        ],
    },
    {
        name: "edge: adjacent whole-block deletions share one separator",
        initMd: "P one.\n\nP two.\n\nP three.\n\nP four.",
        edits: (md) => [
            range(md, "P two.", ""),
            range(md, "P three.", ""),
        ],
    },
    {
        name: "edge: replace trailing part of doc across last separator",
        initMd: PARA_DOC,
        edits: (md) => [
            {
                start: at(md, "here."),
                end: md.length,
                text: "HERE.\n\nBrand new tail.",
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// 1–2. Text faithfulness + canonical shape, per scenario
// ---------------------------------------------------------------------------
for (const scenario of scenarios) {
    const store = makeStore(scenario.initMd);
    const base = store.toMarkdown();
    const edits = scenario.edits(base);
    // The contract is the CANONICALIZED splice: the result serializes like a
    // fresh parse of the spliced text. For every block except tables the two
    // are byte-identical; table serialization re-pads columns (exactly like
    // normal typing does), so byte-level splice equality cannot hold there.
    const splice = spliceAll(base, edits);
    const expected = toMarkdown(freshParse(splice)) || "";
    const result = store.replaceRanges(...edits);

    check(
        `${scenario.name} — all edits applied`,
        result.applied === edits.length && result.failed === 0,
        result,
    );
    const actual = store.toMarkdown();
    check(`${scenario.name} — text faithfulness`, actual === expected, {
        actual,
        expected,
        splice,
    });
    if (!scenario.skipShape) {
        const canonical = topLevelShape(freshParse(actual));
        const ours = topLevelShape(store.renderData_);
        check(
            `${scenario.name} — canonical top-level shape`,
            shapesMatch(ours, canonical),
            { ours, canonical },
        );
    }
}

// ---------------------------------------------------------------------------
// 3. Identity preservation
// ---------------------------------------------------------------------------
{
    const store = makeStore(PARA_DOC);
    const base = store.toMarkdown();
    const prevChildren = store.renderData_.children_;
    const editedUuid = prevChildren[0].uuid_;
    store.replaceRanges(range(base, "beta", "BETA"));
    const nextChildren = store.renderData_.children_;
    check(
        "identity: edited P keeps uuid (merge path)",
        nextChildren[0].uuid_ === editedUuid,
    );
    let reused = 0;
    for (let i = 1; i < prevChildren.length; i += 1) {
        if (nextChildren[i] === prevChildren[i]) reused += 1;
    }
    check(
        "identity: untouched top-level children keep references",
        reused === prevChildren.length - 1,
        { reused, total: prevChildren.length - 1 },
    );
}

// ---------------------------------------------------------------------------
// 3b. SPAN-level identity: editing a few chars must not rewrite the paragraph
// ---------------------------------------------------------------------------
{
    // splitTextSpans pre-splits plain text at sentence granularity, so this
    // paragraph holds several spans. Editing one word must go through the
    // span-preserving merge: only the touched span is replaced; every other
    // span keeps its uuid, and spans outside the change region ±1 (the dirty-
    // DOM guard bumps domVersion_ on the two adjacent ones) keep their exact
    // object references. The op stream must stay span-sized.
    const store = makeStore(
        "First sentence here. Second one follows. Third is the middle. Fourth keeps going. Fifth sentence ends.",
    );
    const block = store.renderData_.children_[0] as ParentRenderData;
    const prevSpans = [...(block.children_ || [])];
    check(
        "span identity: paragraph pre-split into multiple spans",
        prevSpans.length >= 4,
        prevSpans.length,
    );
    const batches: RenderDataOp[][] = [];
    store.subscribeRenderDataOps((ops) => batches.push(ops));
    const base = store.toMarkdown();
    store.replaceRanges(range(base, "middle", "MIDDLE"));

    const nextBlock = store.renderData_.children_[0] as ParentRenderData;
    const nextSpans = nextBlock.children_ || [];
    check(
        "span identity: block uuid preserved",
        nextBlock.uuid_ === block.uuid_,
    );
    const prevUuids = prevSpans.map((s) => s.uuid_);
    const nextUuids = new Set(nextSpans.map((s) => s.uuid_));
    const keptUuids = prevUuids.filter((u) => nextUuids.has(u)).length;
    check(
        "span identity: exactly one span replaced, all others keep uuid",
        keptUuids === prevSpans.length - 1,
        { total: prevSpans.length, keptUuids },
    );
    const keptRefs = prevSpans.filter((s) =>
        nextSpans.includes(s),
    ).length;
    check(
        "span identity: spans outside change region ±1 keep object references",
        keptRefs >= prevSpans.length - 3,
        { total: prevSpans.length, keptRefs },
    );
    const allOps = batches.flat();
    check(
        "span identity: op stream is span-sized (no paragraph rewrite)",
        allOps.length > 0 &&
            allOps.length <= 4 &&
            allOps.every((op) => op.op !== "replaceRoot"),
        allOps,
    );
    // No op may touch a surviving span's text — the change is delete+insert
    // of the replaced span only.
    const untouchedTextSets = allOps.filter(
        (op) =>
            op.op === "set" &&
            op.key === "text" &&
            prevUuids.includes(op.uuid) &&
            nextUuids.has(op.uuid),
    );
    check(
        "span identity: no text mutation on surviving spans",
        untouchedTextSets.length === 0,
        untouchedTextSets,
    );
}

// ---------------------------------------------------------------------------
// 4. Op stream: fine-grained ops, no replaceRoot, replay convergence
// ---------------------------------------------------------------------------
{
    const store = makeStore(MIXED_DOC);
    const base = store.toMarkdown();
    const snapshot = store.getRenderDataSnapshot();
    const batches: RenderDataOp[][] = [];
    store.subscribeRenderDataOps((ops) => batches.push(ops));
    store.replaceRanges(
        range(base, "First para", "1st para"),
        range(base, "- l1", "- L1"),
        range(base, "Last para.", "Final para."),
    );
    const allOps = batches.flat();
    check("ops: batch emitted", allOps.length > 0, allOps.length);
    check(
        "ops: no whole-tree replacement",
        allOps.every((op) => op.op !== "replaceRoot"),
        allOps.filter((op) => op.op === "replaceRoot").length,
    );
    // Replay onto the pristine snapshot → must converge to the same markdown.
    const replayedHolder = produce(
        {
            renderData_: deserializeRenderData(
                snapshot as SerializedRenderData,
            ) as ParentRenderData,
        },
        (draft) => {
            for (const ops of batches) {
                applyRenderDataOpsToDraft(draft, ops);
            }
        },
    );
    check(
        "ops: replay converges to the same markdown",
        toMarkdown(replayedHolder.renderData_) === store.toMarkdown(),
        {
            replayed: toMarkdown(replayedHolder.renderData_),
            local: store.toMarkdown(),
        },
    );
}

// ---------------------------------------------------------------------------
// 5. Undo: one batch = one step
// ---------------------------------------------------------------------------
{
    const store = makeStore(MIXED_DOC);
    const base = store.toMarkdown();
    store.replaceRanges(
        range(base, "Doc", "Document"),
        range(base, "x = 1", "x = 9"),
        range(base, "Last para.", "The end."),
    );
    const after = store.toMarkdown();
    check("undo: batch applied", after !== base);
    store.undo();
    check("undo: one step restores the pristine doc", store.toMarkdown() === base, {
        got: store.toMarkdown(),
    });
    store.redo();
    check("redo: restores the batch", store.toMarkdown() === after, {
        got: store.toMarkdown(),
    });
}

// ---------------------------------------------------------------------------
// replaceText matrix
// ---------------------------------------------------------------------------
{
    const store = makeStore(PARA_DOC);
    const r = store.replaceText({ search: "beta", replace: "BETA" });
    check(
        "replaceText: unique match applies",
        r.applied === 1 && store.toMarkdown().includes("BETA"),
        r,
    );
}
{
    const store = makeStore("dup one dup two dup three");
    const r1 = store.replaceText({ search: "dup", replace: "X" });
    check(
        "replaceText: ambiguous without occurrence fails distinctly",
        r1.applied === 0 && r1.results[0].reason === "ambiguous",
        r1,
    );
    const r2 = store.replaceText({ search: "dup", replace: "X", occurrence: 1 });
    check(
        "replaceText: occurrence picks the right match",
        r2.applied === 1 && store.toMarkdown() === "dup one X two dup three",
        { r2, md: store.toMarkdown() },
    );
    const r3 = store.replaceText({ search: "dup", replace: "X", occurrence: 9 });
    check(
        "replaceText: occurrence out of range",
        r3.applied === 0 &&
            r3.results[0].reason === "occurrence_out_of_range",
        r3,
    );
    const r4 = store.replaceText({ search: "nope", replace: "X" });
    check(
        "replaceText: not found",
        r4.applied === 0 && r4.results[0].reason === "not_found",
        r4,
    );
}
{
    const store = makeStore(PARA_DOC);
    const r = store.replaceText(
        { search: "Alpha", replace: "A1" },
        { search: "missing-needle", replace: "nope" },
        { search: "Third", replace: "T3" },
    );
    const md = store.toMarkdown();
    check(
        "replaceText: best-effort batch (successes apply around a failure)",
        r.applied === 2 &&
            r.failed === 1 &&
            r.results[1].reason === "not_found" &&
            md.includes("A1") &&
            md.includes("T3"),
        { r, md },
    );
}

// ---------------------------------------------------------------------------
// Failure / validation matrix (ranges)
// ---------------------------------------------------------------------------
{
    const store = makeStore(PARA_DOC);
    const base = store.toMarkdown();
    const r = store.replaceRanges(
        { start: 0, end: 10, text: "A" },
        { start: 5, end: 12, text: "B" },
        range(base, "Third", "THIRD"),
    );
    check(
        "ranges: overlap fails both, the rest applies",
        r.applied === 1 &&
            r.failed === 2 &&
            r.results[0].reason === "overlap" &&
            r.results[1].reason === "overlap" &&
            store.toMarkdown().includes("THIRD"),
        r,
    );
}
{
    const store = makeStore(PARA_DOC);
    const base = store.toMarkdown();
    const r = store.replaceRanges({
        start: 0,
        end: base.length + 5,
        text: "X",
    });
    check(
        "ranges: out of bounds",
        r.applied === 0 && r.results[0].reason === "out_of_bounds",
        r,
    );
    check("ranges: failed batch is a no-op", store.toMarkdown() === base);
}
{
    const store = makeStore(PARA_DOC);
    const before = store.renderData_;
    const r = store.replaceRanges();
    check(
        "ranges: zero edits → no-op, state untouched",
        r.applied === 0 && r.failed === 0 && store.renderData_ === before,
        r,
    );
}
{
    const store = makeStore(PARA_DOC);
    const r = store.replaceRanges(
        { start: 3, end: 1, text: "X" },
        { start: 0.5, end: 2, text: "Y" } as RangeEdit,
    );
    check(
        "ranges: malformed edits rejected as invalid",
        r.applied === 0 &&
            r.results.every((x) => x.reason === "invalid"),
        r,
    );
}
{
    // Same-position pure insertions apply in argument order.
    const store = makeStore("AB");
    store.replaceRanges(
        { start: 1, end: 1, text: "X" },
        { start: 1, end: 1, text: "Y" },
    );
    check(
        "ranges: same-position insertions keep argument order",
        store.toMarkdown() === "AXYB",
        store.toMarkdown(),
    );
}

// ---------------------------------------------------------------------------
// Cursor: untouched block keeps the caret; edited block clamps it
// ---------------------------------------------------------------------------
{
    const store = makeStore(PARA_DOC);
    const base = store.toMarkdown();
    const thirdBlock = store.renderData_.children_.find(
        (c) => toMarkdown(c).startsWith("Third"),
    )!;
    store.setCursorInfo_({ uuid: thirdBlock.uuid_, offset: 5 });
    store.replaceRanges(range(base, "beta", "a-longer-replacement"));
    const cur = store.startCursorInfo;
    check(
        "cursor: caret in an untouched block survives the batch",
        !!cur && cur.uuid === thirdBlock.uuid_ && cur.offset === 5,
        cur,
    );
}

// ---------------------------------------------------------------------------
// Diff-scenario end-to-end proxy: reconcile two markdown versions
// ---------------------------------------------------------------------------
{
    // "external" version differs by: title rename, one list item edit,
    // a deleted paragraph, an inserted paragraph, code line change.
    const store = makeStore(MIXED_DOC);
    const current = store.toMarkdown();
    const external = current
        .replace("# Doc", "# Document v2")
        .replace("- l1", "- l1 changed")
        .replace("\n\nLast para.", "")
        .replace("x = 1", "x = 100")
        .replace("First para with **bold** text.", "First para with **bold** text.\n\nBrand new para.");
    // Cheap diff driver: common prefix/suffix → single middle range edit.
    let p = 0;
    while (
        p < current.length &&
        p < external.length &&
        current[p] === external[p]
    ) {
        p += 1;
    }
    let s = 0;
    while (
        s < current.length - p &&
        s < external.length - p &&
        current[current.length - 1 - s] === external[external.length - 1 - s]
    ) {
        s += 1;
    }
    const r = store.replaceRanges({
        start: p,
        end: current.length - s,
        text: external.slice(p, external.length - s),
    });
    check(
        "diff proxy: reconciled markdown equals the external version",
        r.applied === 1 && store.toMarkdown() === external,
        { md: store.toMarkdown(), external },
    );
}

rawLog(`\nverify-replace: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
