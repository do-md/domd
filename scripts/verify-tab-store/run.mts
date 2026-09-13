/**
 * TabStore semantics — the layer none of the other harnesses touch.
 *
 * Every assertion here maps to a review finding on the tabs branch: the
 * bugs all lived in how tab STATE behaves across replacement, switching and
 * dirty marking, while the existing harnesses only proved the parts worked
 * in isolation.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-tab-store/run.mts
 */
import { EditorStore } from "@do-md/core-react";
import { TabStore } from "@/features/editor/stores/tab-store";
import type { FileMeta } from "@/features/editor/lib/types";

let passed = 0;
const failures: string[] = [];

const check = (name: string, ok: boolean, detail = "") => {
    if (ok) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const createRuntime = (initMd: string) =>
    new EditorStore({
        editable: true,
        initMd,
        placeholder: "",
        mode: "rich",
    });

const tauriMeta = (name: string, path: string | null): FileMeta => ({
    kind: "tauri",
    path,
    name,
    docId: null,
    frontmatter: null,
});

// ── Document replacement: fresh runtime, bumped epoch ────────────────────
console.log("document replacement");
{
    const store = new TabStore({ createRuntime });
    const tabId = store.addTab(tauriMeta("a.md", "/tmp/a.md"), "# Alpha\n");
    const before = store.runtimeOf(tabId)!;
    const epochBefore = store.state.tabs[0].docEpoch;

    // Build undo history in the first document.
    before.insertText(" EDIT");
    await sleep(600); // history debounce

    store.replaceTabDoc(tabId, tauriMeta("b.md", "/tmp/b.md"), "# Beta\n");
    const after = store.runtimeOf(tabId)!;

    check("replacement swaps in a fresh runtime", after !== before);
    check(
        "replacement bumps docEpoch (mount key changes)",
        store.state.tabs[0].docEpoch === epochBefore + 1,
    );
    check(
        "new runtime holds the new document",
        (after.toMarkdown() ?? "").includes("Beta"),
    );

    // The C1 regression: undo after a replacement must NOT replay the old
    // document's patches against the new tree.
    const beforeUndo = after.toMarkdown() ?? "";
    after.undo();
    await sleep(50);
    const afterUndo = after.toMarkdown() ?? "";
    check(
        "undo after replacement is inert (fresh history)",
        afterUndo === beforeUndo,
        `before: ${JSON.stringify(beforeUndo)} / after: ${JSON.stringify(afterUndo)}`,
    );
    check(
        "replacement clears dirty and stale flags",
        !store.state.tabs[0].isDirty && !store.state.tabs[0].diskStale,
    );
}

// ── Switching: attach semantics, runtime untouched ───────────────────────
console.log("switching");
{
    const store = new TabStore({ createRuntime });
    const a = store.addTab(tauriMeta("a.md", "/tmp/a.md"), "# Alpha\n");
    const b = store.addTab(tauriMeta("b.md", "/tmp/b.md"), "# Beta\n");
    const runtimeA = store.runtimeOf(a)!;
    const epochA = store.state.tabs[0].docEpoch;

    store.activateTab(a);
    store.activateTab(b);
    store.activateTab(a);

    check("switching never replaces the runtime", store.runtimeOf(a) === runtimeA);
    check(
        "switching never bumps docEpoch",
        store.state.tabs[0].docEpoch === epochA,
    );
}

// ── Dirty marking: the immer no-op and the live registry ─────────────────
console.log("dirty marking");
{
    const store = new TabStore({ createRuntime });
    const tabId = store.addTab(tauriMeta("u.md", null), "");
    let notifications = 0;
    store.subscribe(() => {
        notifications += 1;
    });

    store.markDirty(tabId, true);
    const afterFirst = notifications;
    for (let i = 0; i < 50; i += 1) store.markDirty(tabId, true);

    check("first dirty mark notifies", afterFirst === 1);
    check(
        "same-value dirty marks are silent (immer no-op)",
        notifications === afterFirst,
        `notifications: ${notifications}`,
    );
    // This silence is exactly why anything shipping tab CONTENT elsewhere
    // (update_tabs) cannot key its freshness on state changes alone — the
    // hook layer adds a debounced push for it. The registry itself is never
    // stale:
    store.runtimeOf(tabId)!.insertText("typed after the mark");
    check(
        "contentOf reads live from the runtime, not a snapshot",
        store.contentOf(tabId).includes("typed after the mark"),
    );
}

// ── Close: the runtime dies with its tab ─────────────────────────────────
console.log("closing");
{
    const store = new TabStore({ createRuntime });
    const a = store.addTab(tauriMeta("a.md", "/tmp/a.md"), "# Alpha\n");
    store.addTab(tauriMeta("b.md", "/tmp/b.md"), "# Beta\n");
    check("closeTab closes", store.closeTab(a) === "closed");
    check("closed tab's runtime is dropped", store.runtimeOf(a) === undefined);
    check(
        "last tab refuses to close (window close owns that)",
        store.closeTab(store.state.tabs[0].id) === "last-tab",
    );
}

// ── Blank-tab reuse gate ─────────────────────────────────────────────────
console.log("blank-tab reuse");
{
    const store = new TabStore({ createRuntime });
    const tabId = store.addTab(tauriMeta("Untitled.md", null), "");
    check("lone empty untitled tab is reusable", store.isOnlyBlankTab());
    store.runtimeOf(tabId)!.insertText("x");
    check(
        "typed-into blank tab is NOT reusable (content check is live)",
        !store.isOnlyBlankTab(),
    );
}

console.log(
    `\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""}`,
);
process.exit(failures.length ? 1 : 0);
