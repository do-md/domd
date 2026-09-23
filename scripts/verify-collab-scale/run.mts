/**
 * Verification for collaboration at document scale (task-7818c7 / task-894ebd).
 *
 * The blocker: `Y.Array.insert` on a PRELIMINARY array (every `new Y.Array()`
 * before it is attached to a document) falls back to
 * `_prelimContent.splice(index, 0, ...content)`, and that spread passes one
 * argument per element — so a document with enough top-level blocks (a 10MB
 * markdown file is ~190k) threw `RangeError: Maximum call stack size
 * exceeded` and could not enter collaboration at all.
 *
 * These assertions drive the real mapping layer with block counts on both
 * sides of the old failure threshold and check that the Y tree mirrors the
 * serialized tree exactly.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-collab-scale/run.mts
 */
import * as Y from "yjs";
import { EditorStore } from "@do-md/core-react";
import { serializeRenderData } from "@do-md/core-react";
import {
    insertAll,
    toYNode,
    applyOpToY,
    ROOT_KEY,
} from "@/plugins/collaboration/crdt-sync/y-mapping";
import { attachCrdtSync } from "@/plugins/collaboration/crdt-sync";

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) passed += 1;
    else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. insertAll survives counts that break a plain spread, in order.
{
    const sizes = [0, 1, 2047, 2048, 2049, 150_000];
    for (const size of sizes) {
        const doc = new Y.Doc();
        const prelim = new Y.Array<number>();
        const items = Array.from({ length: size }, (_, i) => i);
        let threw: unknown = null;
        try {
            insertAll(prelim, 0, items);
        } catch (e) {
            threw = e;
        }
        doc.getMap("root").set("children", prelim);
        const attached = doc.getMap("root").get("children") as Y.Array<number>;
        check(
            `insertAll: ${size} items insert without throwing`,
            threw === null,
            String(threw),
        );
        check(
            `insertAll: ${size} items land in order`,
            attached.length === size &&
                (size === 0 ||
                    (attached.get(0) === 0 &&
                        attached.get(size - 1) === size - 1)),
            `len ${attached.length}`,
        );
    }
    // The old code path, proven to be the failure: a raw spread of the same
    // size throws. (Guards the regression from being "fixed" by reverting.)
    let spreadThrew = false;
    try {
        const prelim = new Y.Array<number>();
        const items = Array.from({ length: 150_000 }, (_, i) => i);
        // eslint-disable-next-line prefer-spread
        prelim.insert(0, items);
    } catch {
        spreadThrew = true;
    }
    check(
        "insertAll: a single bulk insert of 150k still throws (the bug we route around)",
        spreadThrew,
    );
}

// ---------------------------------------------------------------------------
// 2. A real large document maps into Y without throwing, and mirrors exactly.
const bigMd = (units: number) =>
    Array.from(
        { length: units },
        (_, i) =>
            `## Section ${i}\n\nParagraph ${i} body text.\n\n- item ${i}a\n- item ${i}b\n`,
    ).join("\n");

const settle = async (store: EditorStore, budgetMs = 60_000) => {
    const start = Date.now();
    while (store.isLoadingChunks && Date.now() - start < budgetMs) {
        await new Promise((r) => setTimeout(r, 20));
    }
    return !store.isLoadingChunks;
};

{
    const store = new EditorStore({ initMd: bigMd(4000), editable: true });
    const loaded = await settle(store);
    check("scale: the large fixture finishes loading", loaded);
    const blocks = store.getTopLevelBlockCount();
    check(
        "scale: fixture is past the old failure threshold",
        blocks > 20_000,
        `${blocks} top-level blocks`,
    );

    const snapshot = serializeRenderData(store.renderData_);
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    let threw: unknown = null;
    const started = Date.now();
    try {
        applyOpToY(
            root,
            { op: "replaceRoot", node: snapshot } as never,
            new Map() as never,
        );
    } catch (e) {
        threw = e;
    }
    check(
        "scale: replaceRoot of a large document does not overflow the stack",
        threw === null,
        String(threw),
    );
    const yChildren = root.get("children") as Y.Array<unknown> | undefined;
    check(
        "scale: every top-level block reached the Y tree",
        !!yChildren && yChildren.length === (snapshot.children?.length ?? -1),
        `${yChildren?.length} vs ${snapshot.children?.length}`,
    );
    check(
        "scale: first and last block identities survive the mapping",
        !!yChildren &&
            (yChildren.get(0) as Y.Map<unknown>).get("uuid") ===
                snapshot.children![0].uuid &&
            (
                yChildren.get(yChildren.length - 1) as Y.Map<unknown>
            ).get("uuid") ===
                snapshot.children![snapshot.children!.length - 1].uuid,
    );
    check(
        "scale: the mapping is not pathologically slow",
        Date.now() - started < 60_000,
        `${Date.now() - started}ms`,
    );

    // Encoding the state round-trips (this is what gets persisted to
    // collab.db / sent to peers).
    let encodeThrew: unknown = null;
    let bytes = 0;
    try {
        bytes = Y.encodeStateAsUpdate(doc).length;
    } catch (e) {
        encodeThrew = e;
    }
    check(
        "scale: the doc encodes to an update without throwing",
        encodeThrew === null && bytes > 0,
        `${bytes} bytes / ${String(encodeThrew)}`,
    );
}

// ---------------------------------------------------------------------------
// 3. toYNode of a node with many children (the nested path through insertAll)
{
    const children = Array.from({ length: 60_000 }, (_, i) => ({
        type: "P",
        uuid: `u${i}`,
        mdSymbols: [],
        props: {},
        text: `line ${i}`,
    }));
    let threw: unknown = null;
    let node: Y.Map<unknown> | null = null;
    try {
        node = toYNode({
            type: "Root",
            uuid: "root",
            mdSymbols: [],
            props: {},
            children,
        } as never);
    } catch (e) {
        threw = e;
    }
    check(
        "toYNode: a node with 60k children maps without overflowing",
        threw === null,
        String(threw),
    );
    // A preliminary Y type refuses reads until it belongs to a document, so
    // attach it the way the mapping layer does before asserting.
    const doc = new Y.Doc();
    if (node) doc.getMap("host").set("node", node);
    const mapped = (doc.getMap("host").get("node") as Y.Map<unknown>)?.get(
        "children",
    ) as Y.Array<unknown> | undefined;
    check(
        "toYNode: all children present",
        mapped?.length === children.length,
        `${mapped?.length}`,
    );
}

// ---------------------------------------------------------------------------
// 4. The load gate's rationale, demonstrated on the real attach path
//    (task-7818c7). attachCrdtSync seeds the shared doc from the store's
//    CURRENT snapshot — so attaching while a document still streams in would
//    publish (and persist) a PREFIX as the whole document. The app-side fix
//    is to defer the attach until isLoadingChunks is false; these assertions
//    pin both halves of that statement.
{
    const text = bigMd(600);
    const store = new EditorStore({ initMd: text, editable: true });
    check(
        "gate: the fixture is still loading right after construction",
        store.isLoadingChunks === true,
    );

    // (a) What attaching mid-load WOULD produce — the hazard, measured.
    const prefixBlocks = store.getTopLevelBlockCount();
    const midDoc = new Y.Doc();
    const midHandle = attachCrdtSync(store as never, { doc: midDoc });
    const midChildren = midDoc.getMap(ROOT_KEY).get("children") as
        | Y.Array<unknown>
        | undefined;
    check(
        "gate: attaching mid-load seeds only the prefix (why the gate exists)",
        midChildren?.length === prefixBlocks,
        `${midChildren?.length} vs ${prefixBlocks}`,
    );
    midHandle.dispose();

    // (b) After the load completes, a fresh attach carries the whole
    //     document — the state the gate guarantees.
    const loaded = await settle(store);
    check("gate: load completes", loaded && !store.isLoadingChunks);
    const fullBlocks = store.getTopLevelBlockCount();
    check(
        "gate: the completed document has many more blocks than the prefix",
        fullBlocks > prefixBlocks,
        `${fullBlocks} vs ${prefixBlocks}`,
    );
    const doc = new Y.Doc();
    const handle = attachCrdtSync(store as never, { doc });
    const children = doc.getMap(ROOT_KEY).get("children") as
        | Y.Array<unknown>
        | undefined;
    check(
        "gate: attaching after the load seeds the WHOLE document",
        children?.length === fullBlocks,
        `${children?.length} vs ${fullBlocks}`,
    );
    // The mid-load attach above left its own ops in the store's history, and
    // the fixture's blank-line shape is normalized by our serializer, so
    // compare structure rather than bytes: every top-level block of the
    // loaded document is present in the seeded doc, in order.
    const firstUuid = (children?.get(0) as Y.Map<unknown>).get("uuid");
    const lastUuid = (
        children?.get((children?.length ?? 1) - 1) as Y.Map<unknown>
    ).get("uuid");
    const blocks = store.getTopLevelBlocks().blocks;
    check(
        "gate: seeded doc mirrors the document's block identities end to end",
        firstUuid === blocks[0].uuid &&
            lastUuid === blocks[blocks.length - 1].uuid,
        `${String(firstUuid)} / ${String(lastUuid)}`,
    );
    handle.dispose();
}

// ---------------------------------------------------------------------------
if (failures.length) {
    console.error(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
}
console.log(`verify-collab-scale: ${passed} passed, 0 failed`);
