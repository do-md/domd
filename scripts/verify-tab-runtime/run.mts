/**
 * Does a hand-constructed EditorStore — the way the tab registry builds one —
 * have a working undo stack?
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-tab-runtime/run.mts
 */
import { EditorStore } from "@do-md/core-react";

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

// Exactly what createRuntime passes in EditorApp, minus the app's injected
// functions (tokenizer/beautifier/imageLoader are irrelevant to history).
const makeRuntime = (initMd: string) =>
    new EditorStore({
        editable: true,
        initMd,
        placeholder: "Start writing Markdown...",
        mode: "rich",
    });

console.log("hand-constructed runtime, undo stack");

const store = makeRuntime("# Alpha\n\nalpha body\n");
const original = store.toMarkdown();
check("constructs and serializes", original.includes("alpha body"), original);

check("exposes undo()", typeof store.undo === "function");
check("exposes redo()", typeof store.redo === "function");

// Edit through the public text path, then undo it.
store.insertText(" EDIT");
const afterEdit = store.toMarkdown();
check("insertText changes the document", afterEdit !== original, afterEdit);

// history debounces at 300ms — let it settle before undoing.
await new Promise((r) => setTimeout(r, 600));
store.undo();
await new Promise((r) => setTimeout(r, 50));
const afterUndo = store.toMarkdown();
check(
    "undo() reverts the edit",
    afterUndo !== afterEdit,
    `after edit: ${JSON.stringify(afterEdit)} / after undo: ${JSON.stringify(afterUndo)}`,
);

console.log(
    `\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""}`,
);
process.exit(failures.length ? 1 : 0);
