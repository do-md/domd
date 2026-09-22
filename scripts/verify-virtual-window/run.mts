/**
 * Verification for the kernel render-window seam (DOM virtualization v1).
 *
 *   1. OFF-MODE EQUIVALENCE — rendering with no RenderWindow produces markup
 *      byte-identical (uuids normalized) to the golden captured from the
 *      pristine pre-seam kernel dist. The off path gained nothing.
 *   2. Pure plan math — computeRenderWindowPlan / resolveTopLevelIndex /
 *      buildRenderWindowPlan invariants, headless.
 *   3. Windowed render — real server renders through RenderWindowContext:
 *      spacers, window slice, kernel-forced pins (cursor block, tail
 *      autofill), order and pad heights.
 *   4. Store accessors — getTopLevelBlocks / getTopLevelUuid.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-virtual-window/run.mts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    DOMD,
    DOMDProvider,
    EditorStore,
    RenderWindowContext,
    computeRenderWindowPlan,
    buildRenderWindowPlan,
    resolveTopLevelIndex,
    type RenderWindow,
    type ParentRenderData,
} from "@do-md/core-react";
import { FIXTURES } from "./fixtures.mts";
import { renderFixture, normalizeUuids } from "./golden.mts";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) passed += 1;
    else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. Off-mode equivalence against the pristine golden
for (const [name] of Object.entries(FIXTURES)) {
    const golden = readFileSync(join(here, "golden", `${name}.html`), "utf8");
    const current = renderFixture(FIXTURES[name]);
    check(
        `off-equivalence: ${name}`,
        current === golden,
        `markup diverged (${current.length} vs ${golden.length} bytes)`,
    );
}

// ---------------------------------------------------------------------------
// 2. Pure plan math
const win = (
    startIndex: number,
    endIndex: number,
    topPad = 100,
    bottomPad = 200,
    pinnedUuids?: string[],
): RenderWindow => ({ startIndex, endIndex, topPad, bottomPad, pinnedUuids });

{
    const plan = computeRenderWindowPlan(100, win(10, 20), []);
    check(
        "plan: basic shape",
        plan.length === 3 &&
            plan[0].kind === "spacer" &&
            plan[0].key === "top" &&
            plan[0].height === 100 &&
            plan[1].kind === "blocks" &&
            plan[1].from === 10 &&
            plan[1].to === 20 &&
            plan[2].kind === "spacer" &&
            plan[2].key === "bottom" &&
            plan[2].height === 200,
        JSON.stringify(plan),
    );
}
{
    const plan = computeRenderWindowPlan(100, win(0, 100, 0, 0), []);
    check(
        "plan: full window emits no spacers",
        plan.length === 1 &&
            plan[0].kind === "blocks" &&
            plan[0].from === 0 &&
            plan[0].to === 100,
        JSON.stringify(plan),
    );
}
{
    const plan = computeRenderWindowPlan(50, win(-5, 900), []);
    const blocks = plan.filter((s) => s.kind === "blocks");
    check(
        "plan: clamps out-of-range window",
        blocks.length === 1 && blocks[0].from === 0 && blocks[0].to === 50,
        JSON.stringify(plan),
    );
}
{
    const plan = computeRenderWindowPlan(100, win(40, 60), [5, 5, 80, 41, -3, 250]);
    const blocks = plan.filter((s) => s.kind === "blocks");
    check(
        "plan: pins dedupe/clamp, in-window pins absorbed",
        JSON.stringify(blocks) ===
            JSON.stringify([
                { kind: "blocks", from: 5, to: 6 },
                { kind: "blocks", from: 40, to: 60 },
                { kind: "blocks", from: 80, to: 81 },
            ]),
        JSON.stringify(blocks),
    );
}
{
    const plan = computeRenderWindowPlan(100, win(40, 60), [39, 38, 60]);
    const blocks = plan.filter((s) => s.kind === "blocks");
    check(
        "plan: adjacent pins merge with the window run",
        JSON.stringify(blocks) ===
            JSON.stringify([{ kind: "blocks", from: 38, to: 61 }]),
        JSON.stringify(blocks),
    );
}
{
    const plan = computeRenderWindowPlan(10, win(3, 3), []);
    check(
        "plan: empty window renders only spacers",
        plan.every((s) => s.kind === "spacer") && plan.length === 2,
        JSON.stringify(plan),
    );
}

// A small synthetic tree for resolveTopLevelIndex / buildRenderWindowPlan.
const leaf = (uuid: string): { uuid_: string; text_: string } => ({
    uuid_: uuid,
    text_: "x",
});
const block = (uuid: string, children: unknown[] = [leaf(`${uuid}-s`)]) => ({
    uuid_: uuid,
    htmlType_: "P",
    children_: children,
});
const tree = {
    uuid_: "root",
    htmlType_: "Root",
    children_: [
        block("b0"),
        block("b1", [block("b1c", [leaf("b1-span")])]),
        block("b2"),
        { ...block("tail"), isAutoFill_: true },
    ],
} as unknown as ParentRenderData;

check(
    "resolve: top-level uuid",
    resolveTopLevelIndex(tree, "b2") === 2,
);
check(
    "resolve: nested block uuid maps to top-level ancestor",
    resolveTopLevelIndex(tree, "b1c") === 1,
);
check(
    "resolve: span uuid maps to top-level ancestor",
    resolveTopLevelIndex(tree, "b1-span") === 1,
);
check("resolve: missing uuid", resolveTopLevelIndex(tree, "nope") === null);
check(
    "resolve: root uuid is not a top-level block",
    resolveTopLevelIndex(tree, "root") === null,
);
check(
    "resolve: stale hint self-heals",
    resolveTopLevelIndex(tree, "b2", 0) === 2,
);

{
    const cache = new Map<string, number>();
    cache.set("b1-span", 0); // stale hint
    const plan = buildRenderWindowPlan(
        tree,
        win(2, 3, 50, 60),
        ["b1-span", null, undefined, "gone"],
        cache,
    );
    const blocks = plan.filter((s) => s.kind === "blocks");
    // Forced pin resolves b1-span → index 1, window covers [2,3), the tail
    // autofill pin adds 3 — all adjacent, so they merge into one run.
    check(
        "buildPlan: forced cursor (nested, stale hint) + tail autofill pinned",
        JSON.stringify(blocks) ===
            JSON.stringify([{ kind: "blocks", from: 1, to: 4 }]),
        JSON.stringify(blocks),
    );
    check(
        "buildPlan: hint cache updated after stale hint",
        cache.get("b1-span") === 1 && !cache.has("gone"),
    );
    // Merged run [1,3) plus tail [3,4) — adjacent, so a second call with the
    // same inputs must be stable (idempotent).
    const again = buildRenderWindowPlan(
        tree,
        win(2, 3, 50, 60),
        ["b1-span"],
        cache,
    );
    check(
        "buildPlan: idempotent with warmed cache",
        JSON.stringify(again.filter((s) => s.kind === "blocks")) ===
            JSON.stringify(blocks),
    );
}
{
    const plan = buildRenderWindowPlan(
        tree,
        win(0, 2, 0, 80, ["b2"]),
        [],
        new Map(),
    );
    const blocks = plan.filter((s) => s.kind === "blocks");
    check(
        "buildPlan: policy pinnedUuids honored",
        JSON.stringify(blocks) ===
            JSON.stringify([{ kind: "blocks", from: 0, to: 4 }]),
        JSON.stringify(blocks),
    );
}

// ---------------------------------------------------------------------------
// 3. Windowed server renders
const windowedMarkup = (
    md: string,
    windowFor: (store: EditorStore) => RenderWindow,
    place?: (store: EditorStore) => void,
): { markup: string; store: EditorStore } => {
    const store = new EditorStore({ initMd: md, editable: true });
    place?.(store);
    const markup = renderToStaticMarkup(
        createElement(
            DOMDProvider,
            { store },
            createElement(
                RenderWindowContext.Provider,
                { value: windowFor(store) },
                createElement(DOMD),
            ),
        ),
    );
    return { markup, store };
};

const longMd = Array.from(
    { length: 40 },
    (_, i) => `Paragraph number ${i} content.`,
).join("\n\n");

{
    const { markup, store } = windowedMarkup(longMd, () => ({
        startIndex: 10,
        endIndex: 16,
        topPad: 1234,
        bottomPad: 5678,
    }));
    const { blocks } = store.getTopLevelBlocks();
    const spacers = markup.match(/data-domd-virtual-spacer="(top|bottom)"/g);
    check(
        "windowed: two spacers",
        spacers?.length === 2 &&
            spacers[0].includes("top") &&
            spacers[1].includes("bottom"),
        String(spacers),
    );
    check(
        "windowed: spacer heights are the pads",
        markup.includes("height:1234px") && markup.includes("height:5678px"),
    );
    check(
        "windowed: spacers are contentEditable=false",
        (markup.match(/data-domd-virtual-spacer[^>]+contenteditable="false"/gi)
            ?.length ?? 0) === 2,
    );
    // The paragraph fixture alternates P / LineBrBr (blank-line scaffolding,
    // rendered as null), so "mounted" means: every block inside [10,16) whose
    // uuid reaches the DOM — exactly the P blocks of the slice, nothing else.
    const mountedIdx = blocks
        .map((b, i) => (markup.includes(b.uuid) ? i : -1))
        .filter((i) => i !== -1);
    const expectedIdx = blocks
        .map((b, i) => (i >= 10 && i < 16 && b.type === "P" ? i : -1))
        .filter((i) => i !== -1);
    check(
        "windowed: exactly the window slice mounts (no cursor, no autofill tail)",
        expectedIdx.length > 0 &&
            JSON.stringify(mountedIdx) === JSON.stringify(expectedIdx),
        JSON.stringify({ mountedIdx, expectedIdx }),
    );
    // blocks[2k] is paragraph k (P at even indexes, LineBrBr between): the
    // window [10,16) shows paragraphs 5..7 and neither neighbor.
    check(
        "windowed: paragraph text of window blocks present",
        markup.includes("Paragraph number 5 ") &&
            markup.includes("Paragraph number 7 ") &&
            !markup.includes("Paragraph number 4 ") &&
            !markup.includes("Paragraph number 8 "),
    );
}
{
    // Cursor far outside the window must stay mounted (kernel-forced pin).
    const { markup, store } = windowedMarkup(
        longMd,
        () => ({
            startIndex: 10,
            endIndex: 16,
            topPad: 100,
            bottomPad: 100,
        }),
        (store) => {
            const { blocks } = store.getTopLevelBlocks();
            // blocks[4] = paragraph 2 (P blocks live at even indexes).
            store.setCursorInfo_({ uuid: blocks[4].uuid, offset: 1 });
        },
    );
    const { blocks } = store.getTopLevelBlocks();
    check(
        "windowed: cursor block outside window stays mounted",
        markup.includes(blocks[4].uuid) &&
            markup.includes("Paragraph number 2 "),
    );
    // DOM order must follow model order: pinned paragraph 2 renders before
    // the window's first paragraph (5).
    check(
        "windowed: pinned block renders in model order",
        markup.indexOf("Paragraph number 2 ") <
            markup.indexOf("Paragraph number 5 "),
    );
}
{
    // Tail autofill (constructor guarantees one after a structural tail; a
    // paragraph doc may not have one — force the check with a fence tail).
    const fenceMd = "para one\n\n```js\ncode line\n```";
    const { markup, store } = windowedMarkup(fenceMd, () => ({
        startIndex: 0,
        endIndex: 1,
        topPad: 0,
        bottomPad: 300,
    }));
    const { blocks } = store.getTopLevelBlocks();
    const tail = blocks[blocks.length - 1];
    check(
        "windowed: tail autofill block always mounts",
        tail.isAutoFill && markup.includes(tail.uuid),
        JSON.stringify(blocks.map((b) => [b.type, b.isAutoFill])),
    );
}

// ---------------------------------------------------------------------------
// 4. Store accessors
{
    const store = new EditorStore({ initMd: longMd, editable: true });
    const { rootUuid, blocks } = store.getTopLevelBlocks();
    check(
        "accessor: getTopLevelBlocks shape",
        rootUuid.length > 0 &&
            blocks.length >= 40 &&
            blocks.every((b) => b.uuid && typeof b.type === "string"),
    );
    const snapshotRoot = store.getRenderDataSnapshot();
    check(
        "accessor: rootUuid matches snapshot root",
        snapshotRoot.uuid === rootUuid,
    );
    check(
        "accessor: getTopLevelUuid identity for top-level block",
        store.getTopLevelUuid(blocks[3].uuid) === blocks[3].uuid,
    );
    // blocks[4] is a P block (even indexes; odd are LineBrBr leaves) — its
    // first child is a span, a genuinely nested uuid.
    const nested = (snapshotRoot.children?.[4].children ?? [])[0];
    check(
        "accessor: getTopLevelUuid resolves a nested uuid",
        nested != null && store.getTopLevelUuid(nested.uuid) === blocks[4].uuid,
    );
    check(
        "accessor: getTopLevelUuid null for unknown uuid",
        store.getTopLevelUuid("missing-uuid") === null,
    );
}

// ---------------------------------------------------------------------------
if (failures.length) {
    console.error(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
}
console.log(`verify-virtual-window: ${passed} passed, 0 failed`);
