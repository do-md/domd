/**
 * Offline verification of the crdt-sync plugin (one-off script). Run:
 * sh verify/run.sh (from this directory).
 *
 * Test bridge note: to produce a "real" op stream, this pulls parseMarkdown /
 * mergeParsedBlock / sync modules straight from core's source to drive
 * FakeStore — only the test script does this; the plugin itself depends solely
 * on the stable public contract (types.ts).
 *
 * Coverage:
 *  V1 mirror consistency: after successive edits, Y.Doc JSON === store snapshot
 *  V2 two sides editing different paragraphs -> merge converges and both edits survive
 *  V3 different spans of the same paragraph concurrently -> in-paragraph merge (the core goal of this upgrade)
 *  V4 same span concurrently -> duplicate kept, no lost text (established semantics)
 *  V5 persistence round-trip: base64 -> new doc -> new store content matches
 */
import { produce, enablePatches } from "immer";
import { parseMarkdown } from "../../../../../../packages/domd-core/src/dataparse/parseMarkdown";
import { mergeParsedBlock } from "../../../../../../packages/domd-core/src/editor/chain/mergeInlineBlock";
import { splitTextSpans } from "../../../../../../packages/domd-core/src/dataparse/postprocess/splitTextSpans";
import {
    diffRenderData,
    serializeRenderData,
    deserializeRenderData,
} from "../../../../../../packages/domd-core/src/editor/sync";
import {
    attachCrdtSync,
    docFromBase64,
    CrdtSyncHandle,
} from "../index";
import type {
    CrdtCapableStore,
    RenderDataOp,
    SerializedRenderData,
} from "../types";

enablePatches();

type AnyNode = {
    htmlType_: string;
    uuid_: string;
    text_?: string;
    children_?: AnyNode[];
};

const flatInternal = (n: AnyNode): string =>
    n.children_ ? n.children_.map(flatInternal).join("") : n.text_ || "";

const flatJSON = (n: SerializedRenderData): string =>
    n.children ? n.children.map(flatJSON).join("") : n.text || "";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
        failures += 1;
        console.log(
            `  ✗ ${name}`,
            detail === undefined ? "" : JSON.stringify(detail),
        );
    }
};
const scenario = (name: string, fn: () => void) => {
    console.log(`\n— ${name}`);
    fn();
};

/** Simulates EditorStore's sync-seam semantics (applyExternal emits no op = echo guard). */
class FakeStore implements CrdtCapableStore {
    tree: AnyNode;
    private listeners = new Set<(ops: RenderDataOp[]) => void>();

    constructor(tree: AnyNode) {
        this.tree = tree;
    }
    getRenderDataSnapshot(): SerializedRenderData {
        return serializeRenderData(this.tree as never);
    }
    subscribeRenderDataOps(l: (ops: RenderDataOp[]) => void) {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }
    applyExternalRenderData(json: SerializedRenderData) {
        this.tree = deserializeRenderData(json) as AnyNode;
    }
    /** Edit block #blockIndex to newText (goes through the real merge + diff + op broadcast). */
    edit(blockIndex: number, newText: string) {
        const prev = this.tree;
        const next = produce({ renderData_: prev }, (draft: any) => {
            const parsed = parseMarkdown(newText) as AnyNode;
            splitTextSpans(parsed as never); // mirrors the runtime's resetTextByUUID_
            const ok = mergeParsedBlock(
                draft.renderData_.children_[blockIndex],
                parsed.children_![0] as never,
            );
            if (ok) {
                // Mirror the runtime: merge the first block of a multi-block result, insert the rest after it.
                if (parsed.children_!.length > 1) {
                    draft.renderData_.children_.splice(
                        blockIndex + 1,
                        0,
                        ...(parsed.children_!.slice(1) as never[]),
                    );
                }
            } else {
                draft.renderData_.children_.splice(
                    blockIndex,
                    1,
                    ...(parsed.children_ as never[]),
                );
            }
        }).renderData_;
        const ops = diffRenderData(prev as never, next as never);
        this.tree = next;
        this.listeners.forEach((l) => l(ops));
    }
}

/** Build a single-paragraph doc already split into spans by bursts: wang -> wangjin -> wangjin tao. */
const buildSegmentedStore = (): FakeStore => {
    const s = new FakeStore(parseMarkdown("wang") as AnyNode);
    s.edit(0, "wangjin");
    s.edit(0, "wangjin tao");
    return s;
};

/** Clone a fresh site from base64 (the doc is the source of truth, flushed back into the store). */
const cloneSite = (
    base64: string,
): { store: FakeStore; handle: CrdtSyncHandle } => {
    const store = new FakeStore(parseMarkdown("") as AnyNode);
    const handle = attachCrdtSync(store, { doc: docFromBase64(base64) });
    return { store, handle };
};

// ---------------------------------------------------------------------------

scenario("V1 mirror consistency: after successive edits, doc === store", () => {
    const store = new FakeStore(parseMarkdown("hello\n\nworld") as AnyNode);
    const handle = attachCrdtSync(store);
    store.edit(0, "hello there");
    store.edit(0, "# hello there"); // fallback path (block type changes)
    const last = store.tree.children_!.length - 1;
    store.edit(last, "world peace");
    const docJSON = (handle.doc.getMap("domdRenderData") as any).toJSON();
    check(
        "doc JSON === store snapshot",
        JSON.stringify(docJSON) === JSON.stringify(store.getRenderDataSnapshot()),
    );
    handle.dispose();
});

scenario("V2 two sides editing different paragraphs merge", () => {
    const base = new FakeStore(parseMarkdown("alpha\n\nbeta") as AnyNode);
    const h0 = attachCrdtSync(base);
    const snapshot = h0.getStateBase64();
    h0.dispose();

    const site1 = cloneSite(snapshot);
    const site2 = cloneSite(snapshot);
    const blocks1 = site1.store.tree.children_!;
    const alphaIdx = blocks1.findIndex((b) => flatInternal(b).includes("alpha"));
    const betaIdx = blocks1.findIndex((b) => flatInternal(b).includes("beta"));

    site1.store.edit(alphaIdx, "alpha ONE");
    site2.store.edit(betaIdx, "beta TWO");

    const u1 = site1.handle.getStateBase64();
    const u2 = site2.handle.getStateBase64();
    site1.handle.applyRemoteBase64(u2);
    site2.handle.applyRemoteBase64(u1);

    const t1 = flatInternal(site1.store.tree);
    const t2 = flatInternal(site2.store.tree);
    check("both sides converge", t1 === t2, { t1, t2 });
    check("both edits survive", t1.includes("alpha ONE") && t1.includes("beta TWO"), t1);
});

scenario("V3 different spans of the same paragraph concurrently (core goal)", () => {
    const base = buildSegmentedStore(); // [wang][jin][ tao]
    const h0 = attachCrdtSync(base);
    const snapshot = h0.getStateBase64();
    h0.dispose();

    const site1 = cloneSite(snapshot);
    const site2 = cloneSite(snapshot);

    site1.store.edit(0, "wangXjin tao"); // insert near the front (new span [X])
    site2.store.edit(0, "wangjin taoY"); // append at the end (new span [Y])

    const u1 = site1.handle.getStateBase64();
    const u2 = site2.handle.getStateBase64();
    site1.handle.applyRemoteBase64(u2);
    site2.handle.applyRemoteBase64(u1);

    const t1 = flatInternal(site1.store.tree);
    const t2 = flatInternal(site2.store.tree);
    check("both sides converge", t1 === t2, { t1, t2 });
    check("in-paragraph merge succeeds (both edits in the same paragraph)", t1 === "wangXjin taoY", t1);
});

scenario("V4 same span concurrently: duplicate kept, no lost text", () => {
    const base = buildSegmentedStore();
    const h0 = attachCrdtSync(base);
    const snapshot = h0.getStateBase64();
    h0.dispose();

    const site1 = cloneSite(snapshot);
    const site2 = cloneSite(snapshot);

    site1.store.edit(0, "wangjZn tao"); // change the middle span [jin]->[jZn]
    site2.store.edit(0, "wangjWn tao"); // same span concurrently ->[jWn]

    const u1 = site1.handle.getStateBase64();
    const u2 = site2.handle.getStateBase64();
    site1.handle.applyRemoteBase64(u2);
    site2.handle.applyRemoteBase64(u1);

    const t1 = flatInternal(site1.store.tree);
    const t2 = flatInternal(site2.store.tree);
    check("both sides converge", t1 === t2, { t1, t2 });
    check(
        "both versions survive (a duplicate beats a loss)",
        t1.includes("jZn") && t1.includes("jWn"),
        t1,
    );
});

scenario("V6 concurrent paragraph split (Enter): shared paragraph is not duplicated", () => {
    const base = new FakeStore(parseMarkdown("shared paragraph here") as AnyNode);
    const h0 = attachCrdtSync(base);
    const snap = h0.getStateBase64();
    h0.dispose();

    const site1 = cloneSite(snap);
    const site2 = cloneSite(snap);

    // Both sides "hit Enter at the end of the same paragraph + type their own new paragraph".
    site1.store.edit(0, "shared paragraph here\n\nfrom client A");
    site2.store.edit(0, "shared paragraph here\n\nfrom client B");

    const u1 = site1.handle.getStateBase64();
    const u2 = site2.handle.getStateBase64();
    site1.handle.applyRemoteBase64(u2);
    site2.handle.applyRemoteBase64(u1);

    const t1 = flatInternal(site1.store.tree);
    const t2 = flatInternal(site2.store.tree);
    check("both sides converge", t1 === t2, { t1, t2 });
    check(
        "shared paragraph appears once (identity preserved, no delete+insert doubling)",
        (t1.match(/shared paragraph here/g) || []).length === 1,
        t1,
    );
    check(
        "both new paragraphs survive",
        t1.includes("from client A") && t1.includes("from client B"),
        t1,
    );
});

scenario("V5 persistence round-trip", () => {
    const store = new FakeStore(
        parseMarkdown("# title\n\nsome **bold** text") as AnyNode,
    );
    const handle = attachCrdtSync(store);
    store.edit(2, "some **bold** text!"); // best-effort edit (index not guaranteed, tolerant)
    const b64 = handle.getStateBase64();
    handle.dispose();

    const restored = cloneSite(b64);
    check(
        "restored content matches the original store",
        flatJSON(restored.store.getRenderDataSnapshot()) ===
            flatInternal(store.tree),
        {
            restored: flatJSON(restored.store.getRenderDataSnapshot()),
            origin: flatInternal(store.tree),
        },
    );
    restored.handle.dispose();
});

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\n✅ All passed" : `\n❌ ${failures} assertion(s) failed`);
// Non-zero exit (node exits 1 on an uncaught exception; avoids depending on @types/node's process).
if (failures) throw new Error(`${failures} assertion(s) failed`);
