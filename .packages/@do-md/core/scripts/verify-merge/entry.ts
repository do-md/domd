/**
 * Offline verification for mergeInlineBlock (one-off script, never shipped in dist).
 * Run: sh scripts/verify-merge/run.sh
 *
 * Uses immer's produceWithPatches to reproduce the real calling environment of
 * `chainProduceParsedData_` (merging onto a draft), then asserts:
 *  1. the merged block's text === the new text (correctness)
 *  2. the old block keeps its `uuid_`, and top-level children outside the changed
 *     region keep their references (structural sharing)
 *  3. patches stay local (no whole-array `children_` replace)
 */
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import { mergeParsedBlock } from "../../src/editor/model/merge/mergeStructural";
import { editorStateChainable } from "../../src/editor/store/chain";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import { splitTextSpans } from "../../src/data-parse/postprocess/splitTextSpans";
import { withSpanAnchor } from "../../src/editor/model/cursor/withSpanAnchor";
import { resolveCursorInfo } from "../../src/editor/model/cursor/resolveCursorInfo";
import { enablePatches, produceWithPatches, Patch } from "immer";

enablePatches();

type AnyNode = {
    htmlType_: string;
    uuid_: string;
    text_?: string;
    children_?: AnyNode[];
};

const flatText = (node: AnyNode): string =>
    node.children_
        ? node.children_.map(flatText).join("")
        : node.text_ || "";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        failures += 1;
        console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail));
    }
};

interface ScenarioResult {
    merged: boolean;
    block: AnyNode;
    root: AnyNode;
    patches: Patch[];
    /**
     * How many top-level children of the new tree are reference-identical to the
     * old tree (a span adjacent to dirty DOM bumps its version, and therefore
     * gets a fresh reference).
     */
    reusedTop: number;
    /**
     * How many top-level children of the new tree carry a uuid that already
     * existed in the old tree — the CRDT identity-preservation measure.
     */
    reusedUuid: number;
    oldTopCount: number;
    newTopCount: number;
    oldUuid: string;
}

/** Run a single merge against state.renderData_.children_[0] (simulates apply). */
const runMerge = (
    state: { renderData_: AnyNode },
    newText: string,
): ScenarioResult => {
    let merged = false;
    const oldBlock = state.renderData_.children_![0];
    const oldTopRefs = new Set(oldBlock.children_ || []);
    const oldTopUuids = new Set((oldBlock.children_ || []).map((c) => c.uuid_));
    const oldUuid = oldBlock.uuid_;

    const [next, patches] = produceWithPatches(state, (draft: any) => {
        const newParsed = parseMarkdown(newText) as AnyNode;
        splitTextSpans(newParsed as never); // mirrors resetTextByUUID_ at runtime
        merged = mergeParsedBlock(
            draft.renderData_.children_[0],
            newParsed.children_![0] as any,
        );
        if (merged) {
            // Mirrors runtime: when parsing yields several blocks, the first
            // one is merged and the rest are inserted right after it.
            if (newParsed.children_!.length > 1) {
                draft.renderData_.children_.splice(
                    1,
                    0,
                    ...(newParsed.children_!.slice(1) as any[]),
                );
            }
        } else {
            draft.renderData_.children_.splice(
                0,
                1,
                ...(newParsed.children_ as any[]),
            );
        }
    });

    const block = next.renderData_.children_![0];
    const reusedTop = (block.children_ || []).filter((c) =>
        oldTopRefs.has(c),
    ).length;
    const reusedUuid = (block.children_ || []).filter((c) =>
        oldTopUuids.has(c.uuid_),
    ).length;
    return {
        merged,
        block,
        root: next.renderData_ as AnyNode,
        patches: patches as Patch[],
        reusedTop,
        reusedUuid,
        oldTopCount: oldTopRefs.size,
        newTopCount: (block.children_ || []).length,
        oldUuid,
    };
};

/**
 * Does any patch replace a whole `children_` array? That is the coarse
 * granularity we are trying to avoid.
 */
const hasWholeChildrenReplace = (patches: Patch[], depth = 3): boolean =>
    patches.some(
        (p) =>
            p.op === "replace" &&
            p.path.length <= depth &&
            p.path[p.path.length - 1] === "children_",
    );

const scenario = (name: string, fn: () => void) => {
    console.log(`\n— ${name}`);
    fn();
};

// ---------------------------------------------------------------------------

scenario("S1 append burst splits naturally: wang → wangjin → wangjin tao", () => {
    const state = { renderData_: parseMarkdown("wang") as AnyNode };
    const r1 = runMerge(state, "wangjin");
    check("merge succeeded", r1.merged);
    check("text is correct", flatText(r1.block) === "wangjin");
    check("uuid preserved", r1.block.uuid_ === r1.oldUuid);
    check(
        "old [wang] span keeps identity (adjacency guard swaps ref); append lands in a new span",
        r1.reusedUuid === 1 && r1.newTopCount === 2,
        { reusedUuid: r1.reusedUuid, total: r1.newTopCount },
    );

    const state2 = { renderData_: { ...state.renderData_, children_: [r1.block] } };
    const r2 = runMerge(state2, "wangjin tao");
    check("second merge produces the correct text", flatText(r2.block) === "wangjin tao");
    check(
        "splits into 3 spans; first 2 keep identity, the non-adjacent one keeps its ref",
        r2.reusedUuid === 2 && r2.newTopCount === 3 && r2.reusedTop === 1,
        { reusedUuid: r2.reusedUuid, reusedRef: r2.reusedTop, total: r2.newTopCount },
    );
});

scenario("S2 mid-edit: only the middle of three spans is replaced", () => {
    // First build up the three spans [wang][jin][ tao].
    const state = { renderData_: parseMarkdown("wang") as AnyNode };
    const a = runMerge(state, "wangjin");
    const b = runMerge(
        { renderData_: { ...state.renderData_, children_: [a.block] } },
        "wangjin tao",
    );
    const r = runMerge(
        { renderData_: { ...state.renderData_, children_: [b.block] } },
        "wangjXn tao",
    );
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "wangjXn tao");
    check(
        "only the middle span is rebuilt (neighbours keep identity, adjacency guard swaps refs)",
        r.reusedUuid === 2 && r.newTopCount === 3,
        { reusedUuid: r.reusedUuid, total: r.newTopCount },
    );
    check(
        "no whole-children replace patch",
        !hasWholeChildrenReplace(r.patches),
        r.patches.map((p) => p.path.join(".")),
    );
});

scenario("S3 add formatting: wang jin → wang **jin** (same text, formatting changed)", () => {
    const state = { renderData_: parseMarkdown("wang jin") as AnyNode };
    const r = runMerge(state, "wang **jin**");
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "wang **jin**");
    // The old tree holds a single leaf "wang jin". Should the prefix "wang " be
    // carved out of it? No — spans are atomic: once the old leaf is touched it
    // enters the changed region as a whole, so that one old span is rebuilt.
    check(
        "change lands on span boundaries (the lone old span is rebuilt, never falsely reused)",
        r.newTopCount >= 2,
        { total: r.newTopCount },
    );
});

scenario("S4 add formatting after splitting: [wang ][jin] → wang **jin**", () => {
    const state = { renderData_: parseMarkdown("wang ") as AnyNode };
    const a = runMerge(state, "wang jin");
    check("setup split into [wang ][jin]", a.newTopCount === 2);
    const r = runMerge(
        { renderData_: { ...state.renderData_, children_: [a.block] } },
        "wang **jin**",
    );
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "wang **jin**");
    check(
        "[wang ] keeps its identity, jin becomes a strong group",
        r.reusedUuid === 1 && r.newTopCount === 2,
        { reusedUuid: r.reusedUuid, total: r.newTopCount },
    );
});

scenario("S5 edit inside a nested node: a**bc**d → a**bXc**d (subtree rebuilt wholesale)", () => {
    const state = { renderData_: parseMarkdown("a**bc**d") as AnyNode };
    const r = runMerge(state, "a**bXc**d");
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "a**bXc**d");
    check(
        "the a and d leaves keep their identity, the strong subtree is rebuilt",
        r.reusedUuid === 2 && r.newTopCount === 3,
        { reusedUuid: r.reusedUuid, total: r.newTopCount },
    );
});

scenario("S6 clamp overlapping affixes: aa → aaa", () => {
    const state = { renderData_: parseMarkdown("aa") as AnyNode };
    const r = runMerge(state, "aaa");
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "aaa");
});

scenario("S7 no-op edit: hello → hello (zero patches)", () => {
    const state = { renderData_: parseMarkdown("hello") as AnyNode };
    const r = runMerge(state, "hello");
    check("merge succeeded", r.merged);
    check("zero patches", r.patches.length === 0, r.patches);
    check("every top-level child keeps its reference", r.reusedTop === r.newTopCount);
});

scenario("S8 header: # hello → # hello world", () => {
    const state = { renderData_: parseMarkdown("# hello") as AnyNode };
    const oldWrapper = state.renderData_.children_![0].children_![1];
    const oldInnerLeaf = oldWrapper.children_![0];
    const r = runMerge(state, "# hello world");
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "# hello world");
    check("H1 uuid preserved", r.block.uuid_ === r.oldUuid);
    // The wrapper becomes a new object because immer copy-on-writes it once its
    // children change (that is correct), but its `uuid_` survives; the MdSymbol
    // leaf and the unchanged leaves inside the wrapper keep their references.
    const newWrapper = r.block.children_![1];
    check("MdSymbol reference preserved", r.reusedTop === 1, { reused: r.reusedTop });
    check("wrapper uuid preserved", newWrapper.uuid_ === oldWrapper.uuid_);
    check(
        "[hello] leaf inside the wrapper keeps its identity (adjacency guard swaps the ref)",
        newWrapper.children_![0].uuid_ === oldInnerLeaf.uuid_,
        { inner: newWrapper.children_!.map((c) => c.text_ ?? "(parent)") },
    );
});

scenario("S9 type change falls back: hello → # hello", () => {
    const state = { renderData_: parseMarkdown("hello") as AnyNode };
    const r = runMerge(state, "# hello");
    check("merge is refused (the caller falls back to a whole-block splice)", !r.merged);
});

scenario("S10 link preserved: edit the text that follows a link", () => {
    const state = {
        renderData_: parseMarkdown("see https://x.com now") as AnyNode,
    };
    const r = runMerge(state, "see https://x.com nowX");
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "see https://x.com nowX");
    check(
        "the text leaf and the Link subtree keep their identity (≥2 of them)",
        r.reusedUuid >= 2,
        { reusedUuid: r.reusedUuid, total: r.newTopCount },
    );
});

scenario("S11 deletion: wangjin tao → wangjin (drop the tail of three spans)", () => {
    const state = { renderData_: parseMarkdown("wang") as AnyNode };
    const a = runMerge(state, "wangjin");
    const b = runMerge(
        { renderData_: { ...state.renderData_, children_: [a.block] } },
        "wangjin tao",
    );
    const r = runMerge(
        { renderData_: { ...state.renderData_, children_: [b.block] } },
        "wangjin",
    );
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "wangjin");
    check(
        "the first 2 spans keep their identity",
        r.reusedUuid === 2 && r.newTopCount === 2,
        { reusedUuid: r.reusedUuid, total: r.newTopCount },
    );
});

scenario("S12 emoji boundary: 🙂x → 🙃x never splits a surrogate pair", () => {
    const state = { renderData_: parseMarkdown("\u{1F642}x") as AnyNode };
    const r = runMerge(state, "\u{1F643}x");
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === "\u{1F643}x");
});

scenario("S13 load-time split: long plain-text paragraph pre-split into sentence spans", () => {
    // Intentional CJK fixture: the two leading sentences exercise CJK sentence
    // splitting and the CJK character weighting in splitTextSpans. Keep the
    // literal verbatim — translating it would change what is under test.
    const md =
        "第一句话这里超过十六个字符。第二句话也不短要有内容。Third sentence in latin. And a fourth one!";
    const tree = parseMarkdown(md) as AnyNode;
    const before = tree.children_![0].children_!.length;
    splitTextSpans(tree as never);
    const after = tree.children_![0].children_!.length;
    check("splits into multiple sentence spans", before === 1 && after >= 4, {
        before,
        after,
        spans: tree.children_![0].children_!.map((c) => c.text_),
    });
    check("text is unchanged", flatText(tree.children_![0]) === md);
});

scenario("S15 paragraph split (Enter) preserves the original block identity", () => {
    const state = {
        renderData_: parseMarkdown("hello world paragraph") as AnyNode,
    };
    const oldUuid = state.renderData_.children_![0].uuid_;
    const r = runMerge(state, "hello world paragraph\n\nnew para");
    check("merge succeeded (the first block is merged)", r.merged);
    check("original block uuid preserved", r.block.uuid_ === oldUuid);
    check(
        "the newly split-off paragraph is inserted after it",
        r.root.children_!.length > 1 &&
            flatText(r.root).includes("new para"),
        {
            blocks: r.root.children_!.map((b) => b.htmlType_),
        },
    );
});

scenario("S14 a legacy single-span paragraph regains granularity on its first edit", () => {
    // Deliberately skip the split, to simulate a single-span paragraph arriving
    // from legacy data or from an external sync.
    // Intentional CJK fixture: exercises CJK sentence splitting and the CJK
    // character weighting in splitTextSpans. Keep the literal verbatim.
    const md = "这是一个很长的段落第一句。这是第二句也有不少字。这是第三句结尾。";
    const state = { renderData_: parseMarkdown(md) as AnyNode };
    check(
        "starts out as a single span",
        state.renderData_.children_![0].children_!.length === 1,
    );
    // Still fixture data: the edit lands inside the second CJK sentence.
    const edited = md.replace("第二句", "第二Y句");
    // runMerge splits the freshly parsed tree internally (mirrors runtime).
    const r = runMerge(state, edited);
    check("merge succeeded", r.merged);
    check("text is correct", flatText(r.block) === edited);
    check("one edit restores sentence-level granularity (≥3 spans)", r.newTopCount >= 3, {
        total: r.newTopCount,
    });
});

// ---------------------------------------------------------------------------
// Part two: sync op-stream verification — the ops produced by diffRenderData,
// applied to a plain-JSON mirror of the old snapshot, must yield exactly the new
// tree's snapshot (the same semantics the Yjs plugin relies on).
// ---------------------------------------------------------------------------
import {
    diffRenderData,
    serializeRenderData,
    deserializeRenderData,
    applyRenderDataOpsToDraft,
    SerializedRenderData,
    RenderDataOp,
} from "../../src/editor/model/sync/renderDataOps";

/**
 * Mirror applier: the same uuid registry and splice semantics as the app-level
 * CRDT plugin.
 */
const applyOpsToMirror = (
    snapshot: SerializedRenderData,
    ops: RenderDataOp[],
): SerializedRenderData => {
    let root = JSON.parse(JSON.stringify(snapshot)) as SerializedRenderData;
    const registry = new Map<string, SerializedRenderData>();
    const register = (n: SerializedRenderData) => {
        registry.set(n.uuid, n);
        n.children?.forEach(register);
    };
    register(root);

    for (const op of ops) {
        if (op.op === "replaceRoot") {
            root = JSON.parse(JSON.stringify(op.node));
            registry.clear();
            register(root);
            continue;
        }
        if (op.op === "insert") {
            const parent = registry.get(op.parent)!;
            const node = JSON.parse(
                JSON.stringify(op.node),
            ) as SerializedRenderData;
            (parent.children ||= []).splice(op.index, 0, node);
            register(node);
            continue;
        }
        if (op.op === "delete") {
            const parent = registry.get(op.parent)!;
            const [removed] = parent.children!.splice(op.index, 1);
            const unregister = (n: SerializedRenderData) => {
                registry.delete(n.uuid);
                n.children?.forEach(unregister);
            };
            if (removed) unregister(removed);
            continue;
        }
        // set
        const target = registry.get(op.uuid)!;
        if (op.key === "children") {
            if (op.value === null) {
                delete target.children;
            } else {
                target.children?.forEach((c) => {
                    registry.delete(c.uuid);
                });
                target.children = JSON.parse(JSON.stringify(op.value));
                target.children!.forEach(register);
                delete target.text;
            }
        } else if (op.key === "type") {
            target.type = op.value as string;
        } else if (op.key === "text") {
            target.text = op.value as string;
            delete target.children;
        } else if (op.key === "props") {
            target.props = JSON.parse(JSON.stringify(op.value));
        } else if (op.key === "mdSymbols") {
            target.mdSymbols = op.value as string[];
        } else if (op.key === "tagName") {
            if (op.value === undefined) delete target.tagName;
            else target.tagName = op.value as string;
        } else if (op.key === "isAutoFill") {
            if (op.value === undefined) delete target.isAutoFill;
            else target.isAutoFill = op.value as boolean;
        }
    }
    return root;
};

const opScenario = (
    name: string,
    oldText: string,
    edits: string[],
) => {
    scenario(name, () => {
        let state = { renderData_: parseMarkdown(oldText) as AnyNode };
        for (const newText of edits) {
            const prevTree = state.renderData_;
            const [next] = produceWithPatches(state, (draft: any) => {
                const newParsed = parseMarkdown(newText) as AnyNode;
                const ok = mergeParsedBlock(
                    draft.renderData_.children_[0],
                    newParsed.children_![0] as any,
                );
                if (!ok) {
                    // Mirror resetTextByUUID_'s fallback: splice the whole block.
                    draft.renderData_.children_.splice(
                        0,
                        1,
                        ...(newParsed.children_ as any[]),
                    );
                }
            });
            const ops = diffRenderData(prevTree as any, next.renderData_ as any);
            const mirrored = applyOpsToMirror(
                serializeRenderData(prevTree as any),
                ops,
            );
            const expected = serializeRenderData(next.renderData_ as any);
            check(
                `"${newText}" mirror matches (${ops.length} ops)`,
                JSON.stringify(mirrored) === JSON.stringify(expected),
                { ops: ops.map((o) => o.op + ("key" in o ? ":" + o.key : "")) },
            );
            state = next as any;
        }
    });
};

opScenario("O1 typing-stream op mirror", "wang", [
    "wangjin",
    "wangjin tao",
    "wangjXn tao",
    "wangjXn",
]);
opScenario("O2 formatting op mirror", "wang jin", ["wang **jin**", "wang **jin**!"]);
opScenario("O3 block type switch (fallback path) op mirror", "hello", [
    "# hello",
    "# hello world",
]);
opScenario("O4 link and nesting op mirror", "see https://x.com now", [
    "see https://x.com nowX",
    "see https://x.com **nowX**",
]);

scenario("O6 op-level replay: equivalence + untouched blocks keep refs (minimal render)", () => {
    // Both peers start from the same source: B shares A's initial tree reference
    // (simulating a clone taken from the same immer evolution chain).
    const initial = parseMarkdown("alpha paragraph\n\nbeta paragraph") as AnyNode;
    const stateA = { renderData_: initial };
    const stateB = { renderData_: initial };

    // A edits the alpha paragraph.
    const blocksA = stateA.renderData_.children_!;
    const alphaIdx = blocksA.findIndex((b) =>
        flatText(b).includes("alpha"),
    );
    const prevA = stateA.renderData_;
    const [nextA] = produceWithPatches(stateA, (draft: any) => {
        const parsed = parseMarkdown("alpha X paragraph") as AnyNode;
        splitTextSpans(parsed as never);
        const ok = mergeParsedBlock(
            draft.renderData_.children_[alphaIdx],
            parsed.children_![0] as any,
        );
        if (!ok) {
            draft.renderData_.children_.splice(
                alphaIdx,
                1,
                ...(parsed.children_ as any[]),
            );
        }
    });
    const ops = diffRenderData(prevA as never, nextA.renderData_ as never);

    // Replay the ops on B (simulating applyExternalRenderDataOps).
    const betaBefore = stateB.renderData_.children_!.find((b) =>
        flatText(b).includes("beta"),
    );
    const [nextB] = produceWithPatches(stateB, (draft: any) => {
        applyRenderDataOpsToDraft(draft, ops);
    });
    const betaAfter = nextB.renderData_.children_!.find((b) =>
        flatText(b).includes("beta"),
    );

    check(
        "after replay, B's tree === A's tree (byte-for-byte structural equivalence)",
        JSON.stringify(serializeRenderData(nextB.renderData_ as never)) ===
            JSON.stringify(serializeRenderData(nextA.renderData_ as never)),
    );
    check(
        "the untouched beta block keeps its exact reference (memo hits = O(changes) rendering)",
        betaAfter === betaBefore && betaAfter !== undefined,
    );
});

// ---------------------------------------------------------------------------
// C series: span-level cursor anchoring (withSpanAnchor / resolveCursorInfo).
// The headline collaboration scenario: two people edit the same paragraph, the
// remote peer rewrites an earlier span, and the local caret must stay pinned to
// its own text — the in-block offset is recomputed as the prefix length changes,
// instead of being pinned to a raw numeric offset.
// ---------------------------------------------------------------------------

scenario("C1 remote edit in a sibling span: anchor holds text position, offset recomputed", () => {
    // A typing burst splits the block into several spans: [wang][jin][ tao].
    const state = { renderData_: parseMarkdown("wang") as AnyNode };
    let r = runMerge(state, "wangjin");
    let cur = { renderData_: r.root };
    r = runMerge(cur, "wangjin tao");
    cur = { renderData_: r.root };
    const block = r.block;
    check("precondition: ≥3 spans in the block", (block.children_ || []).length >= 3);

    // Put the caret inside " tao" (absolute in-block offset 9 = "wangjin t|ao").
    const anchored = withSpanAnchor(
        { uuid: block.uuid_, offset: 9 },
        cur.renderData_ as any,
    );
    check("an anchor was derived", !!anchored.spanUuid);
    const lastSpanUuid = anchored.spanUuid;

    // The "remote" peer edits the first span: wang → wangXYZ (+3); the " tao"
    // span keeps its reference.
    r = runMerge(cur, "wangXYZjin tao");
    check("remote merge succeeded", r.merged);
    const resolved = resolveCursorInfo(anchored, r.root as any);
    check("the block still exists: resolve returns non-null", !!resolved);
    check(
        "offset recomputed from the prefix: 9 → 12 (+3)",
        resolved!.offset === 12,
        resolved,
    );
    check("the anchor span survived (same uuid)", resolved!.spanUuid === lastSpanUuid);
    check(
        "anchored text unchanged: 'ao' is still to the right of the caret",
        flatText(r.block).slice(resolved!.offset) === "ao",
    );
});

scenario("C2 caret's own span is touched: fall back to render+offset (clamp), re-anchor", () => {
    const state = { renderData_: parseMarkdown("wang") as AnyNode };
    let r = runMerge(state, "wangjin");
    let cur = { renderData_: r.root };
    r = runMerge(cur, "wangjin tao");
    cur = { renderData_: r.root };
    const block = r.block;

    // Anchor the caret in " tao" (offset 9); the remote peer rewrites the whole
    // tail, so that span is rebuilt.
    const anchored = withSpanAnchor(
        { uuid: block.uuid_, offset: 9 },
        cur.renderData_ as any,
    );
    const oldSpanUuid = anchored.spanUuid;
    r = runMerge(cur, "wangjin XY");
    const resolved = resolveCursorInfo(anchored, r.root as any);
    check("resolve returns non-null (fallback path)", !!resolved);
    check(
        "fallback primary coordinate: offset stays 9 (≤ the new text length — no drift, no crash)",
        resolved!.offset === 9,
        resolved,
    );
    check(
        "the dead anchor is re-anchored in place onto the new span",
        resolved!.spanUuid !== oldSpanUuid && !!resolved!.spanUuid,
    );

    // Extreme case: the fallback offset runs past the new block length → clamp.
    const farCursor = { uuid: block.uuid_, offset: 999, spanUuid: "nonexist", spanOffset: 0 };
    const clamped = resolveCursorInfo(farCursor, r.root as any);
    check(
        "an out-of-range fallback clamps to the block text length",
        clamped!.offset === flatText(r.block).length,
        clamped,
    );
});

scenario("C3 block deleted / boundary affinity", () => {
    const state = { renderData_: parseMarkdown("hello world") as AnyNode };
    const root = state.renderData_;
    const block = root.children_![0];
    check(
        "missing block → null (a remote caret is not drawn, the local one stays put)",
        resolveCursorInfo(
            { uuid: "gone", offset: 3 },
            root as any,
        ) === null,
    );
    // Affinity matches getDomByCursor: the end of a leaf is inclusive.
    const atEnd = withSpanAnchor(
        { uuid: block.uuid_, offset: flatText(block).length },
        root as any,
    );
    check("offset == end of block is still anchorable", !!atEnd.spanUuid);
    const atZero = withSpanAnchor({ uuid: block.uuid_, offset: 0 }, root as any);
    check(
        "offset == 0 anchors to the first leaf with spanOffset 0",
        !!atZero.spanUuid && atZero.spanOffset === 0,
    );
    // During speculative rendering the DOM runs ahead of the model: an
    // out-of-range offset gives up on anchoring (re-anchoring after apply is the
    // safety net that heals it).
    const overflow = withSpanAnchor(
        { uuid: block.uuid_, offset: flatText(block).length + 5 },
        root as any,
    );
    check(
        "out-of-range offset → no anchor (primary coordinate left as-is)",
        overflow.spanUuid === undefined &&
            overflow.offset === flatText(block).length + 5,
    );
});

scenario("O5 serialization round-trip: deserialize(serialize(tree)) keeps the text", () => {
    const tree = parseMarkdown(
        "# t\n\npara **bold** [l](https://a.b) `c`",
    ) as AnyNode;
    const round = deserializeRenderData(
        serializeRenderData(tree as any),
    ) as AnyNode;
    check("text matches", flatText(round) === flatText(tree));
    check(
        "structure matches",
        JSON.stringify(serializeRenderData(round as any)) ===
            JSON.stringify(serializeRenderData(tree as any)),
    );
});

// ===========================================================================
// D series: scoped reparse for selection delete/replace (deleteSelect_ /
// replaceSelect_). Drives the real chain (editorStateChainable) and asserts:
//  1. text correctness (equivalent to a full reparse)
//  2. the root reference is preserved (no whole-tree replace patch on
//     draft.renderData_)
//  3. top-level children outside the affected range keep their exact references
//     (zero immer patches)
//  4. the first block keeps its uuid identity — from the CRDT's point of view
//     this is an "edit", not a "delete + insert"
// ===========================================================================

const makeChainState = (md: string): any => {
    const renderData_ = parseMarkdown(md);
    splitTextSpans(renderData_ as never); // mirrors the runtime initMd path
    return {
        renderData_,
        editorState_: {
            paddingMdSymbols_: null,
            isEditable_: true,
            activeAtomicUUID_: null,
            pendingInput_: null,
            duringComposition_: false,
            compositionSnapshot_: null,
            renderUUID_: "",
            cursorInRender_: 0,
            placeholder_: "",
            cursorInfo_: { start_: null, end_: null, source_: "model" },
        },
    };
};

const runSelectEdit = (
    state: any,
    cursors: { uuid: string; offset: number }[],
    insertText: string | null, // null = deleteSelect_, otherwise replaceSelect_
) => {
    const [next, patches] = produceWithPatches(state, (draft: any) => {
        const chain = editorStateChainable(draft) as any;
        if (insertText === null) chain.deleteSelect_(cursors);
        else chain.replaceSelect_(cursors, insertText);
    });
    return { next: next as any, patches: patches as Patch[] };
};

const hasRootReplace = (patches: Patch[]) =>
    patches.some((p) => p.path.length === 1 && p.path[0] === "renderData_");

scenario("D1 single-block selection delete: only that block changes, refs elsewhere kept", () => {
    const state = makeChainState(
        "hello world\n\nsecond paragraph\n\nthird one",
    );
    const [p1, brA, p2, brB, p3] = state.renderData_.children_;
    const { next, patches } = runSelectEdit(
        state,
        [
            { uuid: p2.uuid_, offset: 2 },
            { uuid: p2.uuid_, offset: 6 },
        ],
        null,
    );
    check(
        "text is correct ('cond' deleted)",
        toMarkdown(next.renderData_) ===
            "hello world\n\nse paragraph\n\nthird one",
        toMarkdown(next.renderData_),
    );
    check(
        "root reference preserved (no whole-tree replace patch)",
        !hasRootReplace(patches),
        patches.map((p) => p.path.join(".")),
    );
    const nc = next.renderData_.children_;
    check(
        "children outside the range keep their references",
        nc[0] === p1 && nc[1] === brA && nc[3] === brB && nc[4] === p3,
    );
    check("the edited block keeps its uuid", nc[2].uuid_ === p2.uuid_);
    const start = next.editorState_.cursorInfo_.start_;
    check(
        "caret = the edited block, offset 2",
        start?.uuid === p2.uuid_ && start?.offset === 2,
        start,
    );
});

scenario("D2 cross-block selection delete: first block keeps identity, middles deleted", () => {
    const state = makeChainState(
        "one two three\n\nmiddle a\n\nmiddle b\n\nseven eight",
    );
    const ch = state.renderData_.children_;
    // [P1, BrBr, P2, BrBr, P3, BrBr, P4]
    const p1 = ch[0];
    const p4 = ch[6];
    const { next, patches } = runSelectEdit(
        state,
        [
            { uuid: p1.uuid_, offset: 4 }, // "one |two three"
            { uuid: p4.uuid_, offset: 6 }, // "seven |eight"
        ],
        null,
    );
    check(
        "text is correct (merged into 'one eight')",
        toMarkdown(next.renderData_) === "one eight",
        toMarkdown(next.renderData_),
    );
    check("root reference preserved", !hasRootReplace(patches));
    const nc = next.renderData_.children_;
    check("exactly 1 top-level child remains", nc.length === 1, nc.length);
    check("first block keeps its uuid (an edit, not delete + insert)", nc[0].uuid_ === p1.uuid_);
    const start = next.editorState_.cursorInfo_.start_;
    check(
        "caret = the first block, offset 4",
        start?.uuid === p1.uuid_ && start?.offset === 4,
        start,
    );
});

scenario("D3 cross-block replace: insertText at the deletion point, outer refs kept", () => {
    const state = makeChainState(
        "aaa bbb\n\nccc ddd\n\neee fff\n\nggg hhh",
    );
    const ch = state.renderData_.children_;
    // [P1, BrBr, P2, BrBr, P3, BrBr, P4]; select from mid-P2 to mid-P3.
    const p1 = ch[0];
    const brA = ch[1];
    const p2 = ch[2];
    const p3 = ch[4];
    const brC = ch[5];
    const p4 = ch[6];
    const { next, patches } = runSelectEdit(
        state,
        [
            { uuid: p2.uuid_, offset: 4 }, // "ccc |ddd"
            { uuid: p3.uuid_, offset: 4 }, // "eee |fff"
        ],
        "XY",
    );
    check(
        "text is correct",
        toMarkdown(next.renderData_) === "aaa bbb\n\nccc XYfff\n\nggg hhh",
        toMarkdown(next.renderData_),
    );
    check("root reference preserved", !hasRootReplace(patches));
    const nc = next.renderData_.children_;
    check(
        "children outside the range keep their references (P1 / separators / P4)",
        nc[0] === p1 &&
            nc[1] === brA &&
            nc[nc.length - 2] === brC &&
            nc[nc.length - 1] === p4,
    );
    check("the merged block keeps its uuid", nc[2].uuid_ === p2.uuid_);
    const cur = next.editorState_.cursorInfo_;
    check(
        "caret sits after insertText (offset 6) and end has been cleared",
        cur.start_?.uuid === p2.uuid_ &&
            cur.start_?.offset === 6 &&
            cur.end_ === null,
        cur.start_,
    );
});

scenario("D4 cross-block, first block not P/Header (UL): splice fallback, outer untouched", () => {
    const state = makeChainState(
        "before para\n\n- item one\n- item two\n\nafter para",
    );
    const ch = state.renderData_.children_;
    // [P1, BrBr, UL, BrBr, P2]
    const p1 = ch[0];
    const brA = ch[1];
    const ul = ch[2];
    const p2 = ch[4];
    // A list item carries its data-render-id on the li node itself.
    const li1 = ul.children_[0];
    const { next, patches } = runSelectEdit(
        state,
        [
            { uuid: li1.uuid_ ?? li1.htmlProps_?.["data-render-id"], offset: 5 },
            { uuid: p2.uuid_, offset: 6 },
        ],
        null,
    );
    check(
        "text is correct",
        toMarkdown(next.renderData_) === "before para\n\n- item para",
        JSON.stringify(toMarkdown(next.renderData_)),
    );
    check("root reference preserved", !hasRootReplace(patches));
    const nc = next.renderData_.children_;
    check("children outside the range keep their references", nc[0] === p1 && nc[1] === brA);
    check("a caret was set", !!next.editorState_.cursorInfo_.start_);
});

scenario("D5 clearing a code block: ZWSP placeholder guard still applies (task-8c1a6f)", () => {
    const state = makeChainState("```js\nabc\n```");
    const ch = state.renderData_.children_;
    const code = ch[0];
    // Find the code line: the node carrying data-render-id whose text is "abc".
    const findLine = (node: any): any => {
        if (node.htmlProps_?.["data-render-id"] && flatText(node) === "abc")
            return node;
        for (const c of node.children_ || []) {
            const hit = findLine(c);
            if (hit) return hit;
        }
        return null;
    };
    const line = findLine(code);
    check("found the code line", !!line);
    if (!line) return;
    const { next } = runSelectEdit(
        state,
        [
            { uuid: line.uuid_, offset: 0 },
            { uuid: line.uuid_, offset: 3 },
        ],
        null,
    );
    const md = toMarkdown(next.renderData_);
    check(
        "code block structure survives and holds a ZWSP placeholder",
        md.startsWith("```js\n") && md.includes("​"),
        JSON.stringify(md),
    );
});

scenario("D6 endpoints cannot be located: falls back to a full reparse, text still correct", () => {
    const state = makeChainState("alpha beta\n\ngamma delta");
    const p2 = state.renderData_.children_[2];
    const { next, patches } = runSelectEdit(
        state,
        [
            { uuid: "nonexistent-id", offset: 0 },
            { uuid: p2.uuid_, offset: 6 },
        ],
        null,
    );
    check("the fallback path performed a whole-tree replace", hasRootReplace(patches));
    check(
        "text is still correct (the safety net loses no content)",
        typeof toMarkdown(next.renderData_) === "string" &&
            toMarkdown(next.renderData_).length > 0,
    );
});

// ---------------------------------------------------------------------------
console.log(
    failures === 0
        ? "\n✅ All checks passed"
        : `\n❌ ${failures} assertion(s) failed`,
);
if (failures) process.exit(1);
