/**
 * Verification for the "Aa" menu's block-formatting layer
 * (common/lib/markdown-line-format.ts + common/lib/editor-block-format.ts).
 *
 * Every store-driven case runs against a REAL headless EditorStore, so the
 * assertions cover what the kernel actually does with the markdown we hand it
 * — round-trip, reparse and caret replay included — rather than what we hope
 * it does.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-block-format/run.mts
 */
import { EditorStore } from "@do-md/core-react";
import {
    clearFormatting,
    insertDivider,
    insertLink,
    readBlockFormatState,
    setParagraphStyle,
    toggleCodeBlock,
    toggleList,
    toggleQuote,
} from "../../common/lib/editor-block-format";
import {
    buildPrefix,
    fenceMap,
    lineGuards,
    linesInRange,
    parseLine,
} from "../../common/lib/markdown-line-format";
import {
    FORMAT_SHORTCUTS,
    HIDDEN_COMMANDS,
    KERNEL_OWNED_COMMANDS,
    matchFormatShortcut,
    shortcutLabel,
    type FormatCommandId,
} from "../../common/lib/format-shortcuts";

let passed = 0;
const failures: string[] = [];
const eq = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) passed += 1;
    else failures.push(`${name}\n     got: ${a}\n  expect: ${e}`);
};

// ---------------------------------------------------------------- pure layer
eq("parse plain", parseLine("hello"), {
    indent: "",
    quote: "",
    quoteDepth: 0,
    listKind: null,
    checked: false,
    heading: 0,
    content: "hello",
});
eq("parse h2", parseLine("## Title").heading, 2);
eq("parse bullet", parseLine("- item").listKind, "bullet");
eq("parse ordered", parseLine("3. item").listKind, "ordered");
eq("parse ordered paren", parseLine("3) item").listKind, "ordered");
eq("parse todo", [parseLine("- [ ] a").listKind, parseLine("- [x] a").checked], [
    "todo",
    true,
]);
eq(
    "parse quote+list+heading",
    ((p) => [p.quoteDepth, p.listKind, p.heading, p.content])(parseLine("> > - ### deep")),
    [2, "bullet", 3, "deep"],
);
eq("bare bracket is not a todo", parseLine("[ ] not a task").listKind, null);
eq("hash without space is not a heading", parseLine("#tag here").heading, 0);
eq(
    "prefix round trip",
    buildPrefix(parseLine("> - [x] ## x")) + parseLine("> - [x] ## x").content,
    "> - [x] ## x",
);
eq("ordered marker normalises to 1.", buildPrefix(parseLine("7. item")), "1. ");

eq("linesInRange collapsed", linesInRange("aa\nbb\ncc", 4, 4).map((l) => l.text), ["bb"]);
eq("linesInRange spanning", linesInRange("aa\nbb\ncc", 1, 7).map((l) => l.text), [
    "aa",
    "bb",
    "cc",
]);
eq("linesInRange stops at a line start", linesInRange("aa\nbb\ncc", 0, 3).map((l) => l.text), [
    "aa",
]);
eq("fenceMap", fenceMap("a\n```\nc\n```\nb"), [false, true, true, true, false]);
eq("lineGuards table", lineGuards("a\n| x | y |\n| - | - |\nb"), [
    null,
    "table",
    "table",
    null,
]);
eq("lineGuards rule", lineGuards("a\n---\nb"), [null, "rule", null]);
eq("lineGuards code beats table", lineGuards("```\n| x |\n```"), ["code", "code", "code"]);
eq("bullet is not a rule", lineGuards("- item\n--\n***"), [null, null, "rule"]);

// -------------------------------------------------------- store-driven layer
const DOC = [
    "# Title",
    "",
    "alpha line",
    "beta line",
    "",
    "- one",
    "- two",
    "",
    "> quoted",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "plain **bold** and *it* tail",
].join("\n");

const TABLE_DOC = [
    "# Title",
    "",
    "| wojintao | haishi bucuod |",
    "| --- | --- |",
    "| jijian | nizia 2008nian |",
    "",
    "tail para",
].join("\n");

/** A store loaded with `doc`, caret placed at (or selection over) `needle`. */
function at(doc: string, needle: string, opts: { range?: boolean } = {}) {
    const store = new EditorStore({ editable: true, initMd: "" });
    store.resetMD(doc);
    store.setSelection(
        opts.range ? { search: needle } : { search: needle, collapse: "start" },
    );
    return store;
}
const line = (store: { toMarkdown(): string }, index: number) =>
    store.toMarkdown().split("\n")[index];

// paragraph styles ----------------------------------------------------------
{
    const s = at(DOC, "alpha line");
    setParagraphStyle(s, 2);
    eq("P -> H2", line(s, 2), "## alpha line");
    setParagraphStyle(s, 0);
    eq("H2 -> body", line(s, 2), "alpha line");
}
{
    const s = at(DOC, "Title");
    eq("state on H1", readBlockFormatState(s).heading, 1);
    setParagraphStyle(s, 3);
    eq("H1 -> H3", line(s, 0), "### Title");
}
{
    // Heading and list are orthogonal, as in Notes — the kernel round-trips
    // `- ## one` as a heading nested in a list item.
    const s = at(DOC, "one");
    setParagraphStyle(s, 2);
    eq("heading keeps the list marker", line(s, 5), "- ## one");
}

// lists ---------------------------------------------------------------------
{
    const s = at(DOC, "alpha line");
    toggleList(s, "bullet");
    eq("P -> bullet", line(s, 2), "- alpha line");
    toggleList(s, "bullet");
    eq("bullet -> P (toggle off)", line(s, 2), "alpha line");
    toggleList(s, "todo");
    eq("P -> todo", line(s, 2), "- [ ] alpha line");
    toggleList(s, "ordered");
    eq("todo -> ordered", line(s, 2), "1. alpha line");
}
{
    const s = readBlockFormatState(at(DOC, "one"));
    eq("state on bullet", [s.bullet, s.ordered, s.todo], [true, false, false]);
}
{
    const s = at(DOC, "line\nbeta", { range: true });
    toggleList(s, "bullet");
    eq("multi-line bullet", [line(s, 2), line(s, 3)], ["- alpha line", "- beta line"]);
}
{
    const s = at(DOC, "beta line\n\n- one", { range: true });
    toggleList(s, "ordered");
    eq("blank line inside the selection is skipped", [line(s, 3), line(s, 4), line(s, 5)], [
        "1. beta line",
        "",
        "1. one",
    ]);
}

// quote ---------------------------------------------------------------------
{
    const s = at(DOC, "alpha line");
    toggleQuote(s);
    eq("P -> quote", line(s, 2), "> alpha line");
    eq("state quoted", readBlockFormatState(s).quote, true);
    toggleQuote(s);
    eq("quote -> P", line(s, 2), "alpha line");
}

// code block ----------------------------------------------------------------
{
    const s = at(DOC, "alpha line");
    toggleCodeBlock(s);
    eq("wrap in a fence", [line(s, 2), line(s, 3), line(s, 4)], ["```", "alpha line", "```"]);
    eq(
        "wrapped content parses as Pre",
        (s.getRenderDataSnapshot().children ?? []).some((c) => c.type === "Pre"),
        true,
    );
    toggleCodeBlock(s);
    eq("unwrap the fence", line(s, 2), "alpha line");
}
{
    const s = at(DOC, "const a");
    eq("state inside a fence", readBlockFormatState(s).codeBlock, true);
    toggleCodeBlock(s);
    eq("unwrap an existing block", s.toMarkdown().split("\n").slice(9, 12), [
        "",
        "const a = 1;",
        "",
    ]);
}
{
    const s = at(DOC, "const a");
    const before = s.toMarkdown();
    setParagraphStyle(s, 1);
    toggleList(s, "bullet");
    insertLink(s);
    eq("no styling inside a fence", s.toMarkdown(), before);
}

// link ----------------------------------------------------------------------
{
    const s = at(DOC, "tail", { range: true });
    insertLink(s);
    eq("link wraps the selection", line(s, 14), "plain **bold** and *it* [tail](url)");
    eq("url placeholder is left selected", s.getSelectionState(1e6).selected_text, "url");
}
{
    const s = at(DOC, "alpha line");
    insertLink(s);
    eq("empty link at the caret", line(s, 2), "[](url)alpha line");
}

// divider -------------------------------------------------------------------
{
    const s = at(DOC, "alpha line");
    insertDivider(s);
    eq("divider after the caret line", s.toMarkdown().split("\n").slice(2, 6), [
        "alpha line",
        "",
        "---",
        "",
    ]);
    eq(
        "divider parses as HrDiv",
        (s.getRenderDataSnapshot().children ?? []).some((c) => c.type === "HrDiv"),
        true,
    );
}
{
    const s = at(DOC, "beta line");
    insertDivider(s);
    eq("divider reuses the existing blank line", s.toMarkdown().split("\n").slice(3, 7), [
        "beta line",
        "",
        "---",
        "",
    ]);
}

// clear formatting ----------------------------------------------------------
{
    const s = at(DOC, "plain");
    clearFormatting(s);
    eq("clear inline marks", line(s, 14), "plain bold and it tail");
}
{
    const s = at("> - ## **bold** heading", "bold");
    clearFormatting(s);
    eq("clear block markers and inline marks", s.toMarkdown(), "bold heading");
}

// caret / selection replay --------------------------------------------------
{
    const s = at(DOC, "alpha line");
    s.setSelection({ search: "line", occurrence: 0, collapse: "end" });
    const before = s.getSelectionState(1e6).before.length;
    setParagraphStyle(s, 2);
    eq("caret shifts by the prefix delta", s.getSelectionState(1e6).before.length, before + 3);
}
{
    const s = at(DOC, "line\nbeta", { range: true });
    toggleList(s, "bullet");
    eq("range selection is preserved", s.getSelectionState(1e6).selected_text, "line\n- beta");
}

// structural guards ---------------------------------------------------------
{
    // A caret in a table BODY cell is unaddressable: the kernel's
    // getSelectionState reports a `before` that misses the column padding
    // toMarkdown adds, so readTarget's consistency check refuses.
    const s = at(TABLE_DOC, "nizia");
    eq("table body cell is unaddressable", readBlockFormatState(s).available, false);
    eq("table header cell is guarded", readBlockFormatState(at(TABLE_DOC, "haishi")).guard, "table");
    const before = s.toMarkdown();
    setParagraphStyle(s, 1);
    toggleList(s, "bullet");
    toggleQuote(s);
    toggleCodeBlock(s);
    insertLink(s);
    insertDivider(s);
    clearFormatting(s);
    eq("table survives every block action", s.toMarkdown(), before);
}
{
    // A selection starting on prose and running into a table IS addressable,
    // so the per-line guards are what keep the table rows intact.
    const s = at(TABLE_DOC, "Title\n\n| wojintao", { range: true });
    setParagraphStyle(s, 2);
    eq("prose styled, table row untouched", [line(s, 0), line(s, 2).startsWith("|")], [
        "## Title",
        true,
    ]);
}
{
    const s = at("alpha\n\n---\n\nbeta", "---");
    setParagraphStyle(s, 1);
    eq("a rule is never prefixed", line(s, 2), "---");
}

// inert without a cursor ----------------------------------------------------
{
    const s = new EditorStore({ editable: true, initMd: "" });
    s.resetMD(DOC);
    setParagraphStyle(s, 1);
    toggleList(s, "bullet");
    toggleQuote(s);
    insertDivider(s);
    clearFormatting(s);
    eq("no cursor is a no-op", s.toMarkdown(), DOC);
    eq("no cursor reports unavailable", readBlockFormatState(s).available, false);
}
{
    setParagraphStyle(null, 1);
    eq("a null store is safe", readBlockFormatState(null).available, false);
}

// one action == one undo step (replaceRanges' contract) ----------------------
{
    const s = at(DOC, "line\nbeta", { range: true });
    let batches = 0;
    s.subscribeRenderDataOps(() => {
        batches += 1;
    });
    toggleList(s, "bullet");
    eq("one op batch per action", batches, 1);
}

// mark toggling: the contract the keyboard route must match -------------------
// Both the toolbar button and ⌘B call store.format(mark), so these assertions
// pin the behaviour BOTH routes get. (The browser's native contentEditable
// bold, which used to service ⌘B, has no equivalent of the disarm step — that
// was the reported mismatch.)
{
    const s = at(DOC, "alpha line");
    s.format("bold");
    eq("collapsed ⌘B arms the mark", s.formatState.bold.active, true);
    eq("arming writes nothing", line(s, 2), "alpha line");
    s.format("bold");
    eq("second press disarms", s.formatState.bold.active, false);
}
{
    const s = at(DOC, "alpha", { range: true });
    s.format("bold");
    eq("range ⌘B wraps", line(s, 2), "**alpha** line");
    s.format("bold");
    eq("second press unwraps", line(s, 2), "alpha line");
}

// Parity check behind KERNEL_OWNED_COMMANDS: the kernel's ⌘0-⌘6 handler must
// keep agreeing with the menu row, or handing it ownership reintroduces the
// very mismatch we just fixed.
{
    type WithHeader = { setHeaderLevel(level: number): void };
    for (const [needle, level] of [
        ["alpha line", 2],
        ["one", 2],
        ["quoted", 3],
    ] as Array<[string, 1 | 2 | 3]>) {
        const viaKernel = at(DOC, needle);
        (viaKernel as unknown as WithHeader).setHeaderLevel(level);
        const viaMenu = at(DOC, needle);
        setParagraphStyle(viaMenu, level);
        eq(
            `setHeaderLevel(${level}) matches setParagraphStyle @ ${needle}`,
            viaKernel.toMarkdown(),
            viaMenu.toMarkdown(),
        );
    }
}

// shortcut matching ---------------------------------------------------------
type Mods = Partial<Record<"shiftKey" | "altKey" | "metaKey" | "ctrlKey", boolean>>;
/** A keystroke with the platform's PRIMARY modifier held (⌘ on Mac, Ctrl
 *  elsewhere), so one table of expectations can be run against both. */
const press = (code: string, mac: boolean, mods: Mods = {}) => ({
    code,
    metaKey: mac,
    ctrlKey: !mac,
    shiftKey: false,
    altKey: false,
    ...mods,
});

for (const mac of [true, false]) {
    const on = mac ? "mac" : "win";
    const match = (code: string, mods: Mods = {}) =>
        matchFormatShortcut(press(code, mac, mods), { mac });

    eq(`[${on}] primary+B -> bold`, match("KeyB"), "bold");
    eq(`[${on}] primary+I -> italic`, match("KeyI"), "italic");
    eq(`[${on}] primary+U -> underline`, match("KeyU"), "underline");
    eq(`[${on}] shift+primary+X -> strikethrough`, match("KeyX", { shiftKey: true }), "strikethrough");
    eq(`[${on}] shift+primary+H -> highlight`, match("KeyH", { shiftKey: true }), "highlight");
    eq(`[${on}] primary+X (cut) is not strikethrough`, match("KeyX"), null);
    eq(`[${on}] shift+primary+L -> checklist`, match("KeyL", { shiftKey: true }), "checklist");
    eq(`[${on}] primary+L without shift is unbound`, match("KeyL"), null);
    eq(`[${on}] shift+primary+9 -> blockQuote`, match("Digit9", { shiftKey: true }), "blockQuote");
    eq(
        `[${on}] bare key is unbound`,
        matchFormatShortcut({ ...press("KeyB", mac), metaKey: false, ctrlKey: false }, { mac }),
        null,
    );
    // Digits belong to the kernel (setHeaderLevel); we render the hint only.
    eq(`[${on}] primary+1 is left to the kernel`, match("Digit1"), null);
    eq(`[${on}] primary+0 is left to the kernel`, match("Digit0"), null);
    // Hidden commands must not stay reachable by keystroke, or they are only
    // half-hidden — the menu row is gone but the key still fires.
    eq(`[${on}] primary+K is parked while Link is hidden`, match("KeyK"), null);
    eq(
        `[${on}] alt+primary+C is parked while Code Block is hidden`,
        match("KeyC", { altKey: true }),
        null,
    );

    // The FOREIGN modifier must never fire a command. On macOS Ctrl+B / Ctrl+U
    // / Ctrl+K are system-wide emacs text bindings (backward-char, kill-line,
    // kill-to-end-of-line) that work in every text field; on Windows, Meta is
    // the Windows key and belongs to the OS shell. Accepting "either modifier"
    // silently breaks editing on both platforms.
    const foreign = (code: string, mods: Mods = {}) =>
        matchFormatShortcut(
            { ...press(code, mac, mods), metaKey: !mac, ctrlKey: mac },
            { mac },
        );
    eq(`[${on}] foreign modifier + B does not fire`, foreign("KeyB"), null);
    eq(`[${on}] foreign modifier + U does not fire`, foreign("KeyU"), null);
    // Both modifiers together is not our chord either.
    eq(
        `[${on}] meta+ctrl+B does not fire`,
        matchFormatShortcut(
            { ...press("KeyB", mac), metaKey: true, ctrlKey: true },
            { mac },
        ),
        null,
    );
}

// Every command must carry a label for BOTH platforms, or a Windows user sees
// a blank hint where a Mac user sees a glyph.
for (const id of Object.keys(FORMAT_SHORTCUTS) as FormatCommandId[]) {
    const macLabel = shortcutLabel(id, true);
    const winLabel = shortcutLabel(id, false);
    eq(`${id} has a mac glyph label`, /^[⌘⇧⌥⌃]/.test(macLabel), true);
    eq(`${id} has a Ctrl label`, winLabel.startsWith("Ctrl+"), true);
}

// Ownership sets must not overlap — a command with two owners is a command
// whose behaviour depends on which check runs first.
eq("kernel-owned set", [...KERNEL_OWNED_COMMANDS].sort(), [
    "body",
    "heading",
    "subheading",
    "title",
]);
eq("hidden set", [...HIDDEN_COMMANDS].sort(), ["codeBlock", "link"]);
eq(
    "hidden and kernel-owned do not overlap",
    [...HIDDEN_COMMANDS].filter((id) => KERNEL_OWNED_COMMANDS.has(id)),
    [],
);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\n" + failures.map((f) => "  ✗ " + f).join("\n"));
    process.exit(1);
}
