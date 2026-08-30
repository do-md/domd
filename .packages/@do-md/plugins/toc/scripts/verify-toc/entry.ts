/**
 * Headless assertion matrix for @do-md/toc. Run from the package root:
 *   sh scripts/verify-toc/run.sh
 *
 * Two layers:
 *   OUTLINE — pure extraction over real kernel snapshots: heading levels,
 *     plain-text extraction (bold/code/link/image/CJK/inline-rule spans),
 *     blockquote exclusion, nearest-shallower-predecessor depths, empty
 *     and headingless documents, outlineEquals.
 *   STORE — TocStore driving the REAL kernel EditorStore (headless, no
 *     DOM): attach scan, the op relevance filter (paragraph edits must NOT
 *     rescan; heading edits, insertions, deletions and paragraph↔heading
 *     conversions must), active-uuid pruning, detach reset, setActive
 *     no-op guard.
 */
import {
    buildOutline,
    headingText,
    opsAffectOutline,
    outlineEquals,
} from "../../src/outline";
import { TocStore } from "../../src/store";
import { EditorStore } from "../../../../core/src/editor/store";

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

const snapshotOf = (md: string) =>
    new EditorStore({ editable: true, initMd: md }).getRenderDataSnapshot();

// ===========================================================================
// OUTLINE
// ===========================================================================

{
    const outline = buildOutline(
        snapshotOf(
            [
                "# Title One",
                "",
                "plain paragraph",
                "",
                "## Sub **bold** and `code` [link text](https://x.com)",
                "",
                "### Deep CJK 中文标题",
                "",
                "> ## Quoted heading",
                "",
                "#### After quote",
            ].join("\n"),
        ),
    );
    check("outline: heading count (blockquote heading excluded)", outline.headings.length === 4, outline.headings);
    check(
        "outline: levels in document order",
        outline.headings.map((h) => h.level).join(",") === "1,2,3,4",
    );
    check(
        "outline: plain text strips block marker",
        outline.headings[0].text === "Title One",
        outline.headings[0].text,
    );
    check(
        "outline: inline markers dropped, content kept",
        outline.headings[1].text === "Sub bold and code link text",
        outline.headings[1].text,
    );
    check(
        "outline: CJK text preserved",
        outline.headings[2].text === "Deep CJK 中文标题",
        outline.headings[2].text,
    );
    check(
        "outline: depths follow nesting",
        outline.headings.map((h) => h.depth).join(",") === "0,1,2,3",
        outline.headings.map((h) => h.depth),
    );
    check(
        "outline: every heading uuid is indexed as top level",
        outline.headings.every((h) => outline.topLevel.has(h.uuid)),
    );
    check(
        "outline: heading subtree index covers descendants",
        outline.headingSubtree.size > outline.headings.length,
    );
}

{
    // Skipped levels + a document that does not start at h1: the
    // nearest-shallower-predecessor rule (h2 → h4 nests ONE step; a later
    // h3 attaches to the h2, not the h4).
    const outline = buildOutline(
        snapshotOf("## Two\n\n#### Four\n\n### Three\n\n# One\n\n### Under one"),
    );
    check(
        "outline: skipped levels nest one step (2,4,3,1,3)",
        outline.headings.map((h) => h.depth).join(",") === "0,1,1,0,1",
        outline.headings.map((h) => `${h.level}:${h.depth}`),
    );
}

{
    const image = buildOutline(
        snapshotOf("## Img ![alt](https://x.com/a.png) tail"),
    );
    check(
        "outline: image contributes no text",
        image.headings[0].text === "Img tail",
        image.headings[0].text,
    );
    const empty = buildOutline(snapshotOf(""));
    check("outline: empty document -> no headings", empty.headings.length === 0);
    const headingless = buildOutline(snapshotOf("just a paragraph\n\nanother"));
    check(
        "outline: headingless document -> no headings",
        headingless.headings.length === 0,
    );
}

{
    const a = buildOutline(snapshotOf("# A\n\n## B")).headings;
    const b = buildOutline(snapshotOf("# A\n\n## B")).headings;
    check(
        "outlineEquals: same content, different uuids -> NOT equal",
        !outlineEquals(a, b),
    );
    check("outlineEquals: identity", outlineEquals(a, a));
    check(
        "outlineEquals: shallow copy is equal",
        outlineEquals(a, a.map((h) => ({ ...h }))),
    );
}

{
    // The relevance filter in isolation (synthetic ops against a real index).
    const index = buildOutline(snapshotOf("# A\n\npara\n\n## B"));
    const headingUuid = index.headings[0].uuid;
    check(
        "ops: replaceRoot -> rescan",
        opsAffectOutline([{ op: "replaceRoot" }], index),
    );
    check(
        "ops: insert at root -> rescan",
        opsAffectOutline(
            [{ op: "insert", parent: index.rootUuid, uuid: "x" }],
            index,
        ),
    );
    check(
        "ops: set text inside heading subtree -> rescan",
        opsAffectOutline([{ op: "set", uuid: headingUuid, key: "text" }], index),
    );
    check(
        "ops: set text on unknown (paragraph span) uuid -> NO rescan",
        !opsAffectOutline(
            [{ op: "set", uuid: "not-in-any-index", key: "text" }],
            index,
        ),
    );
    check(
        "ops: unknown op kind fails toward rescan",
        opsAffectOutline([{ op: "mystery" }], index),
    );
    check(
        "ops: inserted subtree carrying a heading -> rescan",
        opsAffectOutline(
            [
                {
                    op: "insert",
                    parent: "some-blockquote",
                    node: {
                        type: "Blockquote",
                        uuid: "q",
                        children: [{ type: "H2", uuid: "h", children: [] }],
                    },
                },
            ],
            index,
        ),
    );
}

// ===========================================================================
// STORE (driving the real kernel EditorStore)
// ===========================================================================

const INIT_MD = ["# Alpha", "", "first paragraph", "", "## Beta", "", "tail paragraph"].join("\n");

{
    const editor = new EditorStore({ editable: true, initMd: INIT_MD });
    const toc = new TocStore();
    const detach = toc.attach(editor);

    check("store: attach scans once", toc.scanCount === 1);
    check(
        "store: attach yields the outline",
        toc.state.headings.map((h) => `${h.level}:${h.text}`).join("|") ===
            "1:Alpha|2:Beta",
        toc.state.headings,
    );

    // --- paragraph edit: the common case must NOT rescan --------------------
    const before = toc.state.headings;
    const md = editor.toMarkdown();
    const paraStart = md.indexOf("first paragraph");
    editor.replaceRanges({
        start: paraStart,
        end: paraStart + "first".length,
        text: "FIRST",
    });
    check(
        "store: paragraph edit -> no rescan",
        toc.scanCount === 1,
        toc.scanCount,
    );
    check(
        "store: paragraph edit -> headings reference stable",
        toc.state.headings === before,
    );

    // --- heading title edit -------------------------------------------------
    const md2 = editor.toMarkdown();
    const alphaStart = md2.indexOf("Alpha");
    editor.replaceRanges({
        start: alphaStart,
        end: alphaStart + "Alpha".length,
        text: "Alpha Prime",
    });
    check("store: heading edit -> rescan", toc.scanCount > 1, toc.scanCount);
    check(
        "store: heading edit -> new title visible",
        toc.state.headings[0].text === "Alpha Prime",
        toc.state.headings[0]?.text,
    );

    // --- appending a heading ------------------------------------------------
    const md3 = editor.toMarkdown();
    editor.replaceRanges({
        start: md3.length,
        end: md3.length,
        text: "\n\n### Gamma",
    });
    check(
        "store: appended heading appears",
        toc.state.headings.length === 3 &&
            toc.state.headings[2].text === "Gamma" &&
            toc.state.headings[2].level === 3,
        toc.state.headings,
    );
    check(
        "store: depths recomputed after append",
        toc.state.headings.map((h) => h.depth).join(",") === "0,1,2",
    );

    // --- paragraph -> heading conversion ------------------------------------
    const md4 = editor.toMarkdown();
    const tailStart = md4.indexOf("tail paragraph");
    editor.replaceRanges({
        start: tailStart,
        end: tailStart,
        text: "## ",
    });
    check(
        "store: paragraph converted to heading appears",
        toc.state.headings.some((h) => h.text === "tail paragraph" && h.level === 2),
        toc.state.headings,
    );

    // --- deleting the active heading prunes activeUuid ----------------------
    const gamma = toc.state.headings.find((h) => h.text === "Gamma");
    check("store: precondition, Gamma exists", gamma !== undefined);
    if (gamma) {
        toc.setActive(gamma.uuid);
        check("store: setActive applied", toc.state.activeUuid === gamma.uuid);
        const stateBefore = toc.state;
        toc.setActive(gamma.uuid);
        check(
            "store: setActive same value is a no-op",
            toc.state === stateBefore,
        );
        const md5 = editor.toMarkdown();
        const gammaLine = md5.indexOf("### Gamma");
        editor.replaceRanges({
            start: gammaLine,
            end: gammaLine + "### Gamma".length,
            text: "",
        });
        check(
            "store: deleted heading leaves the outline",
            !toc.state.headings.some((h) => h.text === "Gamma"),
            toc.state.headings,
        );
        check(
            "store: deleted active heading -> activeUuid pruned",
            toc.state.activeUuid === null,
            toc.state.activeUuid,
        );
    }

    // --- detach -------------------------------------------------------------
    detach();
    check("store: detach clears state", toc.state.headings.length === 0);
    const scansAfterDetach = toc.scanCount;
    const md6 = editor.toMarkdown();
    editor.replaceRanges({
        start: md6.length,
        end: md6.length,
        text: "\n\n# Post detach",
    });
    check(
        "store: detached store ignores editor ops",
        toc.scanCount === scansAfterDetach,
    );
}

{
    // Re-attach to a different editor resets cleanly.
    const editorA = new EditorStore({ editable: true, initMd: "# A" });
    const editorB = new EditorStore({ editable: true, initMd: "# B\n\n## B2" });
    const toc = new TocStore();
    toc.attach(editorA);
    check("store: attach A", toc.state.headings[0]?.text === "A");
    toc.attach(editorB);
    check(
        "store: attach B replaces outline",
        toc.state.headings.map((h) => h.text).join("|") === "B|B2",
        toc.state.headings,
    );
    toc.detach();
}

{
    // Pin machinery (the spy's click-highlight override, store side).
    const editor = new EditorStore({
        editable: true,
        initMd: "# One\n\n## Two\n\nbody",
    });
    const toc = new TocStore();
    toc.attach(editor);
    const two = toc.state.headings[1];
    toc.pinActive(two.uuid);
    check(
        "pin: pinActive sets the highlight",
        toc.state.activeUuid === two.uuid,
    );
    const age = toc.pinAge();
    check("pin: pinAge reports a fresh pin", age !== null && age >= 0, age);
    toc.unpin();
    check("pin: unpin clears the age, keeps the highlight",
        toc.pinAge() === null && toc.state.activeUuid === two.uuid,
    );
    // Deleting the pinned heading clears both the pin and the highlight.
    toc.pinActive(two.uuid);
    const md = editor.toMarkdown();
    const line = md.indexOf("## Two");
    editor.replaceRanges({ start: line, end: line + "## Two".length, text: "" });
    check(
        "pin: deleting the pinned heading clears pin + highlight",
        toc.pinAge() === null && toc.state.activeUuid === null,
        { age: toc.pinAge(), active: toc.state.activeUuid },
    );
    toc.pinActive(toc.state.headings[0].uuid);
    toc.detach();
    check("pin: detach clears the pin", toc.pinAge() === null);
}

// ===========================================================================
// resolveBlockOffset (kernel primitive) + moveCaretToHeading (jump caret)
// ===========================================================================

{
    const editor = new EditorStore({
        editable: true,
        initMd: "# Alpha\n\npara\n\n## Sub **bold** text\n\ntail",
    });
    const md = editor.toMarkdown();
    const snapshotBefore = JSON.stringify(editor.getCursorSnapshot());

    const toc = new TocStore();
    toc.attach(editor);
    const [alpha, sub] = toc.state.headings;

    // --- kernel primitive semantics -----------------------------------------
    const alphaRange = editor.resolveBlockOffset(alpha.uuid);
    check(
        "resolveBlockOffset: heading source range is exact",
        alphaRange !== null &&
            md.slice(alphaRange.start, alphaRange.end) === "# Alpha",
        alphaRange,
    );
    const subRange = editor.resolveBlockOffset(sub.uuid);
    check(
        "resolveBlockOffset: formatted heading range is exact",
        subRange !== null &&
            md.slice(subRange.start, subRange.end) === "## Sub **bold** text",
        subRange,
    );
    check(
        "resolveBlockOffset: unknown uuid -> null",
        editor.resolveBlockOffset("no-such-uuid") === null,
    );
    // A nested uuid (any non-top-level node) must not resolve: grab a span
    // uuid from the snapshot.
    const snap = editor.getRenderDataSnapshot();
    const headingNode = (snap.children ?? []).find(
        (c: { uuid: string }) => c.uuid === alpha.uuid,
    ) as { children?: { uuid: string }[] } | undefined;
    const nestedUuid = headingNode?.children?.[0]?.uuid;
    check(
        "resolveBlockOffset: nested uuid -> null",
        nestedUuid !== undefined &&
            editor.resolveBlockOffset(nestedUuid) === null,
        nestedUuid,
    );
    check(
        "resolveBlockOffset: pure read (cursor untouched)",
        JSON.stringify(editor.getCursorSnapshot()) === snapshotBefore,
    );

    // --- caret placement on jump --------------------------------------------
    check(
        "moveCaretToHeading: applies",
        toc.moveCaretToHeading(sub.uuid) === true,
    );
    const offsets = editor.getSelectionOffsets();
    check(
        "moveCaretToHeading: caret lands after the marker run",
        offsets !== null &&
            subRange !== null &&
            offsets.start === subRange.start + sub.level + 1 &&
            offsets.end === offsets.start,
        offsets,
    );
    check(
        "moveCaretToHeading: caret sits on the first text char",
        offsets !== null && md.slice(offsets.start, offsets.start + 3) === "Sub",
    );
    check(
        "moveCaretToHeading: unknown heading -> false",
        toc.moveCaretToHeading("no-such-uuid") === false,
    );
    toc.detach();
    check(
        "moveCaretToHeading: detached -> false",
        toc.moveCaretToHeading(sub.uuid) === false,
    );
}

{
    // Graceful degradation: an editor without resolveBlockOffset (older
    // kernel) keeps the outline working and jump-caret returns false.
    const editor = new EditorStore({ editable: true, initMd: "# Only" });
    const bare = {
        getRenderDataSnapshot: () => editor.getRenderDataSnapshot(),
        subscribeRenderDataOps: (l: (ops: unknown[]) => void) =>
            editor.subscribeRenderDataOps(l),
    };
    const toc = new TocStore();
    toc.attach(bare);
    check(
        "degrade: outline works without optional members",
        toc.state.headings.length === 1,
    );
    check(
        "degrade: moveCaretToHeading -> false, no crash",
        toc.moveCaretToHeading(toc.state.headings[0].uuid) === false,
    );
    toc.detach();
}

{
    // headingText tolerates a leaked cursor marker (defense in depth).
    check(
        "headingText: cursor marker stripped",
        headingText({
            type: "H1",
            uuid: "h",
            children: [{ type: "Plain", uuid: "s", text: "a\uE000b" }],
        }) === "ab",
    );
}

rawLog(`\nverify-toc: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
