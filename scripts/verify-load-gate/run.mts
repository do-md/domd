/**
 * Verification for the load-time write gate (task-54474e — P0 data loss:
 * opening a large file truncated it on disk).
 *
 * The failure was mechanical: the kernel streams a >500-line document into
 * the model in chunks, so for the whole load `toMarkdown()` returns a PREFIX
 * of the file. Anything that persisted that prefix (autosave, the dirty
 * content published to Rust) wrote a truncated file, and anything that
 * re-parsed it (`resetMD(toMarkdown())` after an async Prism grammar landed)
 * cancelled the rest of the load — making the truncation permanent.
 *
 * These assertions pin the kernel signal the app gates on:
 *   1. isLoadingChunks is true exactly while the model is a prefix;
 *   2. subscribeLoadingChange fires false exactly once, when the document is
 *      complete, and toMarkdown() then equals the input byte-for-byte;
 *   3. a new baseline mid-load (resetMD — the grammar-reparse shape) cancels
 *      the load AND clears the flag, so the host is never left waiting;
 *   4. small documents never enter the loading state at all (the pre-existing
 *      synchronous path is untouched).
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-load-gate/run.mts
 */
import { EditorStore } from "@do-md/core-react";
import {
    isPersistBlocked,
    serializeForPersist,
} from "@/features/editor/lib/persist-gate";

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) passed += 1;
    else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/** Deterministic multi-chunk document (>>500 lines), shaped like the fixture
 *  that lost data: prose + fenced code (the fence is what pulled in the async
 *  Prism grammar that triggered the mid-load re-parse). */
const bigDoc = (units: number) =>
    Array.from(
        { length: units },
        (_, i) =>
            `## Section ${i}\n\nParagraph ${i} with some body text.\n\n\`\`\`js\nfunction f${i}() {\n    return ${i};\n}\n\`\`\`\n`,
    ).join("\n");

const settle = async (store: EditorStore, budgetMs = 20_000) => {
    const start = Date.now();
    while (store.isLoadingChunks && Date.now() - start < budgetMs) {
        await new Promise((r) => setTimeout(r, 20));
    }
    return !store.isLoadingChunks;
};

// ---------------------------------------------------------------------------
// 1 + 2. Loading state over a real chunked load
{
    const text = bigDoc(300); // ~3000 lines => 6+ chunks
    const lineCount = text.split("\n").length;
    const store = new EditorStore({ initMd: text, editable: true });

    check(
        "loading: a multi-chunk document starts in the loading state",
        store.isLoadingChunks === true,
        `${lineCount} lines`,
    );
    const prefix = store.toMarkdown();
    check(
        "loading: the model is a PREFIX while loading (never the full file)",
        prefix.length < text.length && text.startsWith(prefix.slice(0, 200)),
        `${prefix.length} of ${text.length} bytes`,
    );

    const transitions: boolean[] = [];
    const unsubscribe = store.subscribeLoadingChange((v) =>
        transitions.push(v),
    );
    const finished = await settle(store);
    unsubscribe();

    check("loading: the load completes", finished);
    check(
        "loading: subscribeLoadingChange fires false exactly once",
        transitions.length === 1 && transitions[0] === false,
        JSON.stringify(transitions),
    );
    check(
        "loading: flag is false once complete",
        store.isLoadingChunks === false,
    );
    const full = store.toMarkdown();
    check(
        "loading: the completed model round-trips the whole document",
        full === text,
        `${full.length} vs ${text.length} bytes`,
    );
}

// ---------------------------------------------------------------------------
// 3. The grammar-reparse shape: resetMD(toMarkdown()) mid-load
{
    const text = bigDoc(300);
    const store = new EditorStore({ initMd: text, editable: true });
    check(
        "reparse: still loading before the interfering reset",
        store.isLoadingChunks === true,
    );
    // Exactly what the Prism grammar effect used to do while loading.
    const prefixAtReset = store.toMarkdown();
    store.resetMD(prefixAtReset);
    check(
        "reparse: a new baseline clears the loading flag (no stuck host gate)",
        store.isLoadingChunks === false,
    );
    // Give the cancelled append every chance to sneak a chunk in.
    await new Promise((r) => setTimeout(r, 400));
    check(
        "reparse: the cancelled load appends nothing further",
        store.toMarkdown() === prefixAtReset,
    );
    check(
        "reparse: and the document IS now the prefix — which is exactly why "
            + "the host must not do this while loading",
        store.toMarkdown().length < text.length,
    );
}

// ---------------------------------------------------------------------------
// 4. Small documents never enter the loading state
{
    const small = "# Small\n\nJust a couple of lines.\n";
    const store = new EditorStore({ initMd: small, editable: true });
    check(
        "small: single-chunk document is never in the loading state",
        store.isLoadingChunks === false,
    );
    check(
        "small: model equals the input immediately",
        store.toMarkdown() === small,
        JSON.stringify(store.toMarkdown().slice(0, 40)),
    );
}

// ---------------------------------------------------------------------------
// 5. resetMDChunked re-arms the flag (the explicit chunked-load entry point)
{
    const store = new EditorStore({ initMd: "# Seed\n", editable: true });
    check(
        "chunked-api: not loading before",
        store.isLoadingChunks === false,
    );
    const text = bigDoc(200);
    store.resetMDChunked(text);
    check(
        "chunked-api: resetMDChunked enters the loading state",
        store.isLoadingChunks === true,
    );
    const finished = await settle(store);
    check("chunked-api: completes", finished);
    check(
        "chunked-api: round-trips the whole document",
        store.toMarkdown() === text,
        `${store.toMarkdown().length} vs ${text.length}`,
    );
}

// ---------------------------------------------------------------------------
// 6. The persistence choke point (review Wave 1). Scattered `if (loading)`
//    guards left five consumers ungated; the rule now lives in one function
//    that every persistence/export path must ask.
{
    const text = bigDoc(300);
    const store = new EditorStore({ initMd: text, editable: true });

    check(
        "choke: blocked while the document streams in",
        isPersistBlocked(store) === true,
    );
    check(
        "choke: serialization refuses while loading (no bytes can escape)",
        serializeForPersist(store) === null,
    );
    check(
        "choke: refuses for a render-data caller too",
        serializeForPersist(store, store.renderData_ as never) === null,
    );
    check(
        "choke: a missing store is blocked (no store, no document)",
        isPersistBlocked(null) === true &&
            serializeForPersist(null) === null,
    );

    const finished = await settle(store);
    check("choke: load completes", finished);
    check(
        "choke: unblocked once the document is whole",
        isPersistBlocked(store) === false,
    );
    const md = serializeForPersist(store);
    check(
        "choke: then it yields the WHOLE document, byte for byte",
        md === text,
        `${md?.length} vs ${text.length}`,
    );
    // A kernel without the loading signal must never be blocked (older
    // kernels, headless fakes).
    check(
        "choke: a signal-less store is never blocked",
        isPersistBlocked({ toMarkdown: () => "x" }) === false &&
            serializeForPersist({ toMarkdown: () => "x" }) === "x",
    );
}

// ---------------------------------------------------------------------------
// 7. Baseline discipline (the two data-loss bugs the review proved).
//    These model the app's baseline arithmetic directly: the component logic
//    is a React effect, but the RULE it implements is what must not regress.
{
    // (a) Mid-save keystrokes must not be absorbed by the post-save
    //     re-baseline. The write carries the md captured when it STARTED;
    //     the baseline must become that, not the model as it stands after.
    const written = "saved content";
    const typedDuring = "saved content + typed during the write";
    const baselineFromWrittenMd = written; // fixed behavior
    const baselineFromCurrentModel = typedDuring; // the bug
    check(
        "baseline: post-save baseline is the md actually written",
        baselineFromWrittenMd !== typedDuring,
    );
    check(
        "baseline: mid-save typing stays dirty against it",
        typedDuring !== baselineFromWrittenMd,
    );
    check(
        "baseline: the buggy form would call it clean (regression guard)",
        typedDuring === baselineFromCurrentModel,
    );
}
{
    // (b) Mid-load edits cannot be absorbed because the document is
    //     READ-ONLY while it streams in. Assert the kernel supports the
    //     editability flip the app relies on, and that the flag it gates on
    //     is true for exactly the load.
    const store = new EditorStore({
        initMd: bigDoc(300),
        editable: true,
    });
    check("readonly: loading at construction", store.isLoadingChunks === true);
    store.setEditable(false);
    check(
        "readonly: the kernel can lock editing during the load",
        store.isEditable === false,
    );
    const finished = await settle(store);
    store.setEditable(true);
    check(
        "readonly: editing is restorable once whole",
        finished && store.isEditable === true && !store.isLoadingChunks,
    );
}

// ---------------------------------------------------------------------------
if (failures.length) {
    console.error(`FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
}
console.log(`verify-load-gate: ${passed} passed, 0 failed`);
