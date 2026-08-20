/**
 * Soft-break (Shift+Enter = insertText("\n")) headless assertion matrix.
 * Run: sh scripts/verify-softbreak/run.sh
 *
 * Contract: a literal "\n" inserted at the cursor goes through the normal
 * insertText → resetTextByUUID_ reparse pipeline; the resulting semantics
 * per context are asserted here:
 *   - P mid/end: same P keeps the "\n" (pre-wrap soft break);
 *   - li end: parseUL autofill turns it into the next li item;
 *   - li mid / header / blockquote: truncated at the "\n" per literal
 *     markdown semantics (block + LineBr + remainder);
 *   - code: a new line inside the fence;
 *   - untouched sibling blocks stay untouched.
 * (Table cells are guarded in EditorController.handleSoftBreakInCursor_ — a literal
 * "\n" would split the row line and break the table on reparse.)
 */
import { EditorStore } from "../../src/editor/store";
import { toMarkdown } from "../../src/editor/model/serialize/toMarkdown";
import { ParentRenderData, RenderData } from "../../src/editor/type";

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

type AnyNode = ParentRenderData | RenderData;

/** Every non-root node with a data-render-id (block-level cursor anchors). */
const collectBlocks = (root: AnyNode): AnyNode[] => {
    const out: AnyNode[] = [];
    const walk = (node: AnyNode) => {
        if (
            node !== root &&
            (node as ParentRenderData).htmlProps_?.["data-render-id"]
        ) {
            out.push(node);
        }
        (node as ParentRenderData).children_?.forEach(walk);
    };
    walk(root);
    return out;
};

const shape = (root: AnyNode): string =>
    ((root as ParentRenderData).children_ || [])
        .map(
            (c) =>
                `${String(c.htmlType_)}(${JSON.stringify(toMarkdown(c) || "")})`,
        )
        .join("|");

const scenario = (
    name: string,
    initMd: string,
    blockText: string,
    offset: number,
    expect: { md: string; shape?: string; cursorBlockText?: string },
) => {
    const store = new EditorStore({ editable: true, initMd });
    const blocks = collectBlocks(store.renderData_);
    const node = blocks.find((b) => (toMarkdown(b) || "") === blockText);
    if (!node) {
        check(`${name}: target block found`, false, {
            want: blockText,
            have: blocks.map((b) => toMarkdown(b) || ""),
        });
        return;
    }
    store.insertText("\n", { uuid: node.uuid_, offset });

    const md = toMarkdown(store.renderData_);
    check(`${name}: md`, md === expect.md, { got: md, want: expect.md });
    if (expect.shape !== undefined) {
        // A trailing autofill EmptyP serializes to "" — drop it before asserting shape
        const got = shape(store.renderData_)
            .replace(/\|EmptyP\(""\)$/, "")
            .replace(/^EmptyP\(""\)\|/, "");
        check(`${name}: shape`, got === expect.shape, {
            got,
            want: expect.shape,
        });
    }
    if (expect.cursorBlockText !== undefined) {
        const cur = store.startCursorInfo;
        const hit =
            cur &&
            collectBlocks(store.renderData_).find((b) => b.uuid_ === cur.uuid);
        check(
            `${name}: cursor block`,
            !!hit && (toMarkdown(hit) || "") === expect.cursorBlockText,
            {
                cursor: cur,
                got: hit ? toMarkdown(hit) : "<no block>",
                want: expect.cursorBlockText,
            },
        );
    }
};

// —— P: the main soft-break scenarios ——
scenario("P mid", "hello world", "hello world", 5, {
    md: "hello\n world",
    shape: 'P("hello\\n world")',
    cursorBlockText: "hello\n world",
});
scenario("P end", "hello", "hello", 5, {
    md: "hello\n",
    shape: 'P("hello\\n")',
    cursorBlockText: "hello\n",
});
scenario("P start", "hello", "hello", 0, {
    md: "\nhello",
    shape: 'LineBr("\\n")|P("hello")',
    cursorBlockText: "hello",
});
scenario("P mid, siblings untouched", "aaa\n\nbbb ccc\n\nddd", "bbb ccc", 3, {
    md: "aaa\n\nbbb\n ccc\n\nddd",
    shape: 'P("aaa")|LineBrBr("\\n\\n")|P("bbb\\n ccc")|LineBrBr("\\n\\n")|P("ddd")',
});

// —— list: end of an li = the next li item (autofill), the list stays intact ——
scenario("li end -> next li item", "- hello", "hello", 5, {
    md: "- hello\n",
    shape: 'Ul("- hello\\n")',
    cursorBlockText: "",
});
scenario("li end (multi) -> next li item", "- aa\n- bb", "bb", 2, {
    md: "- aa\n- bb\n",
    shape: 'Ul("- aa\\n- bb\\n")',
    cursorBlockText: "",
});
scenario("checkbox li end -> next item", "- [ ] task", "task", 4, {
    md: "- [ ] task\n",
    shape: 'Ul("- [ ] task\\n")',
    cursorBlockText: "",
});
scenario("li mid -> literal split", "- hello", "hello", 3, {
    md: "- hel\nlo",
    shape: 'Ul("- hel")|LineBr("\\n")|P("lo")',
    cursorBlockText: "lo",
});

// —— heading / blockquote: truncated at the literal \n ——
scenario("header mid", "# hello", "# hello", 5, {
    md: "# hel\nlo",
    shape: 'H1("# hel")|LineBr("\\n")|P("lo")',
    cursorBlockText: "lo",
});
scenario("blockquote mid", "> hello", "hello", 3, {
    md: "> hel\nlo",
    shape: 'Blockquote("> hel")|LineBr("\\n")|P("lo")',
    cursorBlockText: "lo",
});

// —— code block: a new line ——
scenario("code mid", "```js\nabcd\n```", "abcd", 2, {
    md: "```js\nab\ncd\n```",
    shape: 'Pre("```js\\nab\\ncd\\n```")',
    cursorBlockText: "ab\ncd",
});

rawLog(`\nsoft-break matrix: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
