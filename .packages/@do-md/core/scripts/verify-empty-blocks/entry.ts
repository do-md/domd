/**
 * Empty-block round-trip assertion matrix.
 * Run: sh scripts/verify-empty-blocks/run.sh
 *
 * Markdown can only express an empty to-do item and an empty blockquote by
 * leaning on a trailing space (`- [ ] `, `> `), which makes them the states
 * most easily lost by a parser that normalizes whitespace. This suite locks
 * the two invariants that keep them alive:
 *
 *   1. FIXED POINT — parse(serialize(x)) === parse(x) for every empty-block
 *      shape, and serialize(parse(md)) === md for the canonical forms the
 *      serializer itself emits. A kernel that cannot reparse its own output
 *      loses the block on every file save/load cycle.
 *   2. PATH AGREEMENT — the marker-bearing path (live typing, which reparses
 *      with a CursorMarker holding the slot open) and the marker-free path
 *      (external edits via replaceRanges, and plain file loads via resetMD)
 *      must produce the SAME tree. These used to disagree, and only the
 *      marker-free path was broken — which is why the bug surfaced through
 *      the toolbar commands and never through the keyboard.
 *
 * Plus the fidelity rule underneath both: a list block keeps the trailing
 * spaces of its last content line, exactly like every other block parser.
 */
import { EditorStore } from "../../src/editor/store";

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

/**
 * Structural fingerprint over the PUBLIC snapshot shape (type / children /
 * text — the same stable keys `serializeRenderData` hands to host plugins),
 * so these assertions read the tree the way an integrator would.
 */
type SnapshotNode = { type: string; children?: SnapshotNode[]; text?: string };

const shape = (node: SnapshotNode): string =>
    node.children?.length
        ? `${node.type}(${node.children.map(shape).join(",")})`
        : `${node.type}${node.text ? JSON.stringify(node.text) : ""}`;

const snapshot = (store: EditorStore) =>
    store.getRenderDataSnapshot() as unknown as SnapshotNode;

const load = (md: string) => {
    const store = new EditorStore({ editable: true, initMd: "" });
    store.resetMD(md);
    return store;
};

/* ------------------------------------------------------------------ *
 * 1. Canonical forms are fixed points of the round trip.
 * ------------------------------------------------------------------ */
const FIXED_POINTS = [
    "- [ ] ",
    "- [x] ",
    "* [ ] ",
    "+ [ ] ",
    "> ",
    "> > ",
    "> - [ ] ",
    "- [ ] a\n- [ ] \n- [ ] b",
    "- a\n- [ ] \n- b",
    "alpha\n\n> \n\nbeta",
    "alpha\n\n- [ ] \n\nbeta",
    // The fidelity rule these depend on: list blocks keep trailing spaces.
    "- foo  ",
    "- foo  \n- bar",
    "- [ ] a  \n- [ ] b",
];
for (const md of FIXED_POINTS) {
    const once = load(md).toMarkdown();
    check(`fixed point: ${JSON.stringify(md)}`, once === md, {
        got: once,
        want: md,
    });
}

/* ------------------------------------------------------------------ *
 * 2. Empty blocks survive as editable blocks, not as literal text.
 * ------------------------------------------------------------------ */
const STRUCTURES: [string, string][] = [
    [
        "- [ ] ",
        "Ul(CheckBoxLi(CheckBoxLabel(CheckboxesInput,Plain),EmptyP(Br)))",
    ],
    ["> ", "Blockquote(EmptyP(Br))"],
];
for (const [md, want] of STRUCTURES) {
    const got = (snapshot(load(md)).children ?? []).map(shape).join("|");
    check(`structure: ${JSON.stringify(md)}`, got === want, { got, want });
}

// An empty to-do must not degrade into a bullet carrying literal "[ ]" text.
for (const md of ["- [ ] ", "- [ ] a\n- [ ] \n- [ ] b"]) {
    const dump = JSON.stringify(snapshot(load(md)));
    check(
        `no literal checkbox text: ${JSON.stringify(md)}`,
        !dump.includes('"[ ]"'),
        dump.slice(0, 200),
    );
}

// An empty blockquote must not evaporate.
check(
    "empty quote keeps its block",
    load("alpha\n\n> \n\nbeta").toMarkdown().includes("> "),
    load("alpha\n\n> \n\nbeta").toMarkdown(),
);

/* ------------------------------------------------------------------ *
 * 3. Typed (marker-bearing) and loaded (marker-free) paths agree.
 * ------------------------------------------------------------------ */
for (const seq of ["> ", "- [ ] "]) {
    const typed = new EditorStore({ editable: true, initMd: "" });
    typed.resetMD("");
    typed.setSelection({ start: 0 });
    for (const ch of seq) typed.insertText(ch);

    check(
        `typed ${JSON.stringify(seq)}: serializes canonically`,
        typed.toMarkdown() === seq,
        {
            got: typed.toMarkdown(),
        },
    );

    const loadedShape = shape(snapshot(load(seq)));
    // The typed document carries a trailing empty paragraph the loaded one
    // does not; compare the block that was actually built.
    const typedShape = shape((snapshot(typed).children ?? [])[0]);
    check(
        `typed ${JSON.stringify(seq)}: same tree as loading it`,
        loadedShape.includes(typedShape),
        { typed: typedShape, loaded: loadedShape },
    );

    // Typing into the empty block has to land inside it.
    typed.insertText("hi");
    const want = seq + "hi";
    check(
        `typed ${JSON.stringify(seq)}: accepts input`,
        typed.toMarkdown() === want,
        {
            got: typed.toMarkdown(),
            want,
        },
    );
}

/* ------------------------------------------------------------------ *
 * 4. External edits (the replaceRanges path the command layer uses).
 * ------------------------------------------------------------------ */
const EXTERNAL: [string, number, string, string, number][] = [
    // [doc, caret, inserted prefix, expected md, expected caret after]
    ["", 0, "- [ ] ", "- [ ] ", 6],
    ["", 0, "> ", "> ", 2],
    ["alpha\n\n\n\nbeta", 7, "- [ ] ", "alpha\n\n- [ ] \n\nbeta", 13],
    ["alpha\n\n\n\nbeta", 7, "> ", "alpha\n\n> \n\nbeta", 9],
];
for (const [doc, caret, prefix, wantMd, wantCaret] of EXTERNAL) {
    const store = load(doc);
    store.setSelection({ start: caret });
    store.replaceRanges({ start: caret, end: caret, text: prefix });
    const md = store.toMarkdown();
    check(
        `replaceRanges ${JSON.stringify(prefix)} @${caret}: md`,
        md === wantMd,
        {
            got: md,
            want: wantMd,
        },
    );

    // The caret has to be addressable at the slot right after the marker;
    // a lost character would put it out of bounds and the set would fail.
    const applied = store.setSelection({ start: wantCaret });
    check(
        `replaceRanges ${JSON.stringify(prefix)} @${caret}: caret lands`,
        !!applied,
        applied,
    );

    store.insertText("hi");
    const typedWant = wantMd.replace(prefix, prefix + "hi");
    check(
        `replaceRanges ${JSON.stringify(prefix)} @${caret}: accepts input`,
        store.toMarkdown() === typedWant,
        { got: store.toMarkdown(), want: typedWant },
    );
}

/* ------------------------------------------------------------------ *
 * 5. Nothing else in the quote serializer moved: blank lines inside a
 *    multi-line child still emit a bare `>`.
 * ------------------------------------------------------------------ */
const UNCHANGED = [
    "> a\n>\n> b",
    "> ```\n> x\n>\n> y\n> ```",
    "> quote\n\npara",
    ">",
    ">\n> a",
];
for (const md of UNCHANGED) {
    const once = load(md).toMarkdown();
    check(`untouched: ${JSON.stringify(md)}`, once === md, {
        got: once,
        want: md,
    });
}

rawLog(`\nverify-empty-blocks: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
