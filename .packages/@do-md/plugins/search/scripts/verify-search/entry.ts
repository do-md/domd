/**
 * Headless assertion matrix for @do-md/search. Run from the package root:
 *   sh scripts/verify-search/run.sh
 *
 * Two layers:
 *   MATCHER — pure semantics: literal escaping, case folding, u-flag
 *     fallback, non-overlapping scan, zero-length skip, multiline anchors,
 *     match limit + limitHit, whole-word boundaries (separator table, CJK),
 *     replacement expansion ($n/$&/$$/two-digit/escapes), preserve-case.
 *   STORE — SearchStore driving the REAL kernel EditorStore (headless, no
 *     DOM): open/prefill/fromCursor anchoring, navigation wrap, option
 *     rescans, regex error surfacing, replace-current advance semantics,
 *     replace-all as ONE undo step, preserve-case + regex groups end to end,
 *     external-edit rescan with keepNear, close() landing the model
 *     selection, detach reset, resolveMatchAnchors against the real
 *     resolveRanges (cap + active tail slot).
 */
import {
    compileQuery,
    expandReplacement,
    findMatches,
    preserveCase,
    SearchMatch,
    SearchOptions,
} from "../../src/matcher";
import { SearchStore } from "../../src/store";
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

const OPTS = (over: Partial<SearchOptions> = {}): SearchOptions => ({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...over,
});

const scan = (
    text: string,
    query: string,
    options: SearchOptions = OPTS(),
    limit?: number,
) => findMatches(text, compileQuery(query, options), options, limit);

// ===========================================================================
// MATCHER
// ===========================================================================

// --- compileQuery -----------------------------------------------------------
check("compile: empty query", compileQuery("", OPTS()).kind === "empty");
check(
    "compile: literal dot is escaped",
    scan("a.b axb", "a.b").matches.length === 1 &&
        scan("a.b axb", "a.b").matches[0].start === 0,
);
check(
    "compile: invalid regex reports error",
    compileQuery("ta(ri", OPTS({ regex: true })).kind === "error",
);
check(
    "compile: u-flag fallback keeps sloppy escapes working",
    (() => {
        const compiled = compileQuery("\\q", OPTS({ regex: true }));
        return (
            compiled.kind === "ok" &&
            scan("a q b", "\\q", OPTS({ regex: true })).matches.length === 1
        );
    })(),
);

// --- findMatches ------------------------------------------------------------
check(
    "scan: case-insensitive by default",
    scan("Foo foo FOO", "foo").matches.length === 3,
);
check(
    "scan: case-sensitive option",
    scan("Foo foo FOO", "foo", OPTS({ caseSensitive: true })).matches
        .length === 1,
);
check(
    "scan: non-overlapping left to right",
    scan("aaaa", "aa").matches.map((m) => m.start).join(",") === "0,2",
);
check(
    "scan: zero-length matches skipped, scan terminates",
    scan("bbb", "a*", OPTS({ regex: true })).matches.length === 0,
);
check(
    "scan: zero-length skip keeps real matches",
    scan("xxyx", "x*", OPTS({ regex: true })).matches.map(
        (m) => `${m.start}-${m.end}`,
    ).join(",") === "0-2,3-4",
);
check(
    "scan: multiline caret addresses line starts",
    scan("a\nb\nba", "^b", OPTS({ regex: true })).matches.length === 2,
);
{
    const limited = scan("x x x", "x", OPTS(), 2);
    check(
        "scan: limit caps matches and reports limitHit",
        limited.matches.length === 2 && limited.limitHit === true,
    );
    const exact = scan("x x", "x", OPTS(), 2);
    check("scan: limit not hit when exact", exact.limitHit === false);
}
check(
    "scan: regex captures groups at scan time",
    (() => {
        const m = scan("ab cd", "(a)(b)", OPTS({ regex: true })).matches[0];
        return !!m.groups && m.groups.join(",") === "ab,a,b";
    })(),
);

// --- whole word -------------------------------------------------------------
const WW = OPTS({ wholeWord: true });
check(
    "word: separator-delimited matches only",
    scan("item items item.", "item", WW).matches.length === 2,
);
check("word: substring rejected", scan("nitems", "item", WW).matches.length === 0);
check(
    "word: match's own separator edge counts as boundary",
    scan("x (foo) y", "(foo)", WW).matches.length === 1,
);
check(
    "word: CJK neighbour is a word character (VSCode parity)",
    scan("词汇 词", "词", WW).matches.length === 1 &&
        scan("词汇 词", "词", WW).matches[0].start === 3,
);

// --- expandReplacement ------------------------------------------------------
const M = (groups: string[]): SearchMatch => ({
    start: 0,
    end: groups[0]?.length ?? 0,
    groups,
});
check(
    "expand: numbered groups",
    expandReplacement("$2-$1", M(["ab", "a", "b"])) === "b-a",
);
check("expand: $& whole match", expandReplacement("[$&]", M(["ab", "a", "b"])) === "[ab]");
check("expand: $$ literal dollar", expandReplacement("$$1", M(["ab", "a", "b"])) === "$1");
check("expand: $0 whole match", expandReplacement("$0", M(["ab", "a", "b"])) === "ab");
check(
    "expand: missing group stays literal",
    expandReplacement("$5", M(["ab", "a", "b"])) === "$5",
);
check(
    "expand: two-digit group when it exists",
    expandReplacement("$10", M(["m", ...Array.from({ length: 10 }, (_, i) => `g${i + 1}`)])) ===
        "g10",
);
check(
    "expand: two-digit falls back to one digit + literal",
    expandReplacement("$10", M(["ab", "a", "b"])) === "a0",
);
check(
    "expand: escapes",
    expandReplacement("a\\nb\\tc\\\\d", M(["m"])) === "a\nb\tc\\d",
);
check(
    "expand: unknown escape stays literal",
    expandReplacement("a\\qb", M(["m"])) === "a\\qb",
);

// --- preserveCase -----------------------------------------------------------
check("case: UPPER", preserveCase("HELLO", "world") === "WORLD");
check("case: lower", preserveCase("hello", "World") === "world");
check("case: Title", preserveCase("Hello", "world") === "World");
check("case: no cased letters passes through", preserveCase("123", "world") === "world");
check("case: empty replacement", preserveCase("Hello", "") === "");
check("case: empty match", preserveCase("", "world") === "world");

// ===========================================================================
// STORE — against the real kernel EditorStore, headless
// ===========================================================================

const CORPUS = [
    "# Tauri Notes",
    "",
    "tauri is great. TAURI wins. Tauri again.",
    "",
    "- item tauri one",
    "- item two",
    "",
    "| name | value |",
    "| ---- | ----- |",
    "| tauri | 42 |",
    "",
    "```js",
    "const tauri = 1;",
    "```",
].join("\n");

const makePair = (initMd: string = CORPUS) => {
    const editor = new EditorStore({ editable: true, initMd });
    const search = new SearchStore();
    search.attach(editor);
    return { editor, search };
};

const occurrenceStarts = (doc: string, needle: string): number[] => {
    const out: number[] = [];
    let from = 0;
    for (;;) {
        const at = doc.toLowerCase().indexOf(needle.toLowerCase(), from);
        if (at === -1) return out;
        out.push(at);
        from = at + needle.length;
    }
};

// --- open / scan / navigation ----------------------------------------------
{
    const { editor, search } = makePair();
    const doc = editor.toMarkdown();
    const expected = occurrenceStarts(doc, "tauri");

    search.openFind();
    check("store: opens", search.state.open === true);
    check("store: empty query scans nothing", search.state.matches.length === 0);

    search.setQuery("tauri");
    check(
        "store: match count equals naive scan",
        search.state.matches.length === expected.length,
        { got: search.state.matches.length, want: expected.length },
    );
    check(
        "store: match offsets equal naive scan",
        search.state.matches.map((m) => m.start).join(",") ===
            expected.join(","),
    );
    check("store: first match active", search.state.activeIndex === 0);

    search.findNext();
    check("store: next advances", search.state.activeIndex === 1);
    search.findPrevious();
    search.findPrevious();
    check(
        "store: previous wraps to last",
        search.state.activeIndex === search.state.matches.length - 1,
    );
    search.findNext();
    check("store: next wraps to first", search.state.activeIndex === 0);

    // Option rescan
    search.setOption("caseSensitive", true);
    check(
        "store: case-sensitive rescan",
        search.state.matches.length === 4,
        search.state.matches.length,
    );
    search.setOption("caseSensitive", false);

    // Regex error surfacing
    search.setOption("regex", true);
    search.setQuery("ta(ri");
    check(
        "store: regex error surfaces, zero matches",
        search.state.queryError !== null && search.state.matches.length === 0,
    );
    search.setQuery("ta.ri");
    check(
        "store: regex error clears",
        search.state.queryError === null &&
            search.state.matches.length === expected.length,
    );
}

// --- prefill + fromCursor anchoring -----------------------------------------
{
    const { editor, search } = makePair();
    const doc = editor.toMarkdown();
    const upperAt = doc.indexOf("TAURI");
    editor.setSelection({ start: upperAt, end: upperAt + 5 });

    search.openFind();
    check("store: selection prefills query", search.state.query === "TAURI");
    const active = search.state.matches[search.state.activeIndex];
    check(
        "store: active anchors at the caret's match",
        active?.start === upperAt,
        { active, upperAt },
    );
    search.close();

    // Multi-line selections must NOT prefill
    const crossStart = doc.indexOf("Tauri again.");
    editor.setSelection({ start: crossStart, end: doc.indexOf("item two") });
    search.openFind();
    check(
        "store: multi-line selection does not prefill",
        search.state.query === "TAURI",
    );
}

// --- replace current: advance-past semantics --------------------------------
{
    const { editor, search } = makePair("b b b");
    search.openFind();
    search.setQuery("b");
    search.setReplacement("bb");
    search.replaceCurrent();
    check("store: replace-current applies", editor.toMarkdown() === "bb b b");
    const active = search.state.matches[search.state.activeIndex];
    check(
        "store: active advances past the inserted text",
        !!active && active.start >= 2,
        { active },
    );
}

// --- replace current + undo -------------------------------------------------
{
    const { editor, search } = makePair();
    const original = editor.toMarkdown();
    search.openFind();
    search.setQuery("tauri");
    search.setReplacement("cargo");
    search.replaceCurrent();
    check(
        "store: replace-current rewrites the heading",
        editor.toMarkdown().startsWith("# cargo Notes"),
        editor.toMarkdown().split("\n")[0],
    );
    editor.undo();
    check("store: one undo restores replace-current", editor.toMarkdown() === original);
}

// --- replace all: preserve case, ONE undo step ------------------------------
{
    const { editor, search } = makePair();
    const original = editor.toMarkdown();
    search.openFind();
    search.setQuery("tauri");
    search.setReplacement("cargo");
    search.setOption("preserveCase", true);
    search.replaceAll();
    const after = editor.toMarkdown();
    check(
        "store: preserve-case replace-all",
        after.startsWith("# Cargo Notes") &&
            after.includes("cargo is great. CARGO wins. Cargo again.") &&
            !/tauri/i.test(after),
        after.split("\n").slice(0, 3),
    );
    check("store: rescan empties matches", search.state.matches.length === 0);
    editor.undo();
    check("store: ONE undo restores replace-all", editor.toMarkdown() === original);
}

// --- regex group replacement end to end -------------------------------------
{
    const { editor, search } = makePair();
    const original = editor.toMarkdown();
    search.openFind();
    search.setOption("regex", true);
    search.setQuery("(item) (\\w+)");
    search.setReplacement("$2 $1");
    check("store: regex finds both list rows", search.state.matches.length === 2);
    search.replaceAll();
    const lines = editor.toMarkdown().split("\n").filter((l) => l.startsWith("- "));
    check(
        "store: group swap applied",
        lines.join("|") === "- tauri item one|- two item",
        lines,
    );
    editor.undo();
    check("store: one undo restores regex replace-all", editor.toMarkdown() === original);
}

// --- external edits rescan with keepNear ------------------------------------
{
    const { editor, search } = makePair();
    search.openFind();
    search.setQuery("tauri");
    search.findNext(); // active = #1 (second match)
    const before = search.state.matches.length;
    const activeStart = search.state.matches[search.state.activeIndex].start;
    const len = editor.toMarkdown().length;
    editor.replaceRanges({ start: len, end: len, text: "\n\ntauri tail" });
    check(
        "store: external edit rescans",
        search.state.matches.length === before + 1,
        { before, after: search.state.matches.length },
    );
    const reanchored = search.state.matches[search.state.activeIndex];
    check(
        "store: active re-anchors near previous offset",
        reanchored?.start === activeStart,
        { reanchored, activeStart },
    );
}

// --- close lands the model selection ----------------------------------------
{
    const { editor, search } = makePair();
    search.openFind();
    search.setQuery("TAURI");
    search.setOption("caseSensitive", true);
    search.close();
    check("store: close resets state", search.state.open === false && search.state.matches.length === 0);
    check(
        "store: close lands selection on the match",
        editor.getSelectionState().selected_text === "TAURI",
        editor.getSelectionState().selected_text,
    );
}

// --- resolveMatchAnchors against the real kernel ----------------------------
{
    const { editor, search } = makePair();
    search.openFind();
    search.setQuery("tauri");
    const anchors = search.resolveMatchAnchors();
    check(
        "store: every match resolves to block anchors",
        anchors.length === search.state.matches.length &&
            anchors.every((a) => a !== null && !!a.start.uuid && !!a.end.uuid),
        anchors.length,
    );
    // Cap: 2 resolved + the active match riding in a tail slot
    search.findNext();
    search.findNext();
    search.findNext(); // activeIndex = 3, beyond a cap of 2
    const capped = search.resolveMatchAnchors(2);
    check(
        "store: cap appends the active match as a tail slot",
        capped.length === 3 && capped.every((a) => a !== null),
        capped.length,
    );
    const activeMatch = search.state.matches[3];
    const sel = editor.setSelection({ start: activeMatch.start, end: activeMatch.end });
    const snap = editor.getCursorSnapshot();
    check(
        "store: tail slot equals setSelection placement of the active match",
        sel.applied === true &&
            capped[2]?.start.uuid === snap.start?.uuid &&
            capped[2]?.start.offset === snap.start?.offset,
        { tail: capped[2], snap: snap.start },
    );
}

// --- detach resets ----------------------------------------------------------
{
    const { search } = makePair();
    search.openFind();
    search.setQuery("tauri");
    search.detach();
    check(
        "store: detach resets to initial state",
        search.state.open === false &&
            search.state.query === "" &&
            search.state.matches.length === 0,
    );
}

rawLog(`@do-md/search verification: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
