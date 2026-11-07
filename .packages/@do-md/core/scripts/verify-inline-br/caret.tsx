/**
 * Caret placement around line breaks, in a real browser.
 * Run: sh scripts/verify-inline-br/caret.sh   (headless Chrome)
 *
 * The real kernel (EditorStore + DOMDProvider + DOMD, rich mode) mounted in
 * a page. Each case places the model caret, lets the cursor replay put the
 * DOM selection where getDomByCursor says, then types with
 * document.execCommand("insertText") — which in Chrome fires no beforeinput,
 * so the kernel's input takeover stays out and the text lands exactly where
 * the browser's own caret is. That is the path IME composition takes, and the
 * one that exposed the bug: a caret placed at (br, 0) on a mid-line <br>
 * lives at the END of the previous line, so the text went before the break.
 *
 * Keys go through the kernel's keydown takeover (Enter / Shift+Enter /
 * Backspace), the same path a real key press takes.
 */
import { createRoot } from "react-dom/client";
import { DOMD, DOMDProvider, EditorStore } from "../../src";

const lines: string[] = [];
let passes = 0;
let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
        passes += 1;
    } else {
        failures += 1;
        lines.push(`FAIL ${name} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
    }
};

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const mount = async (md: string) => {
    const host = document.createElement("div");
    host.style.width = "480px";
    document.body.appendChild(host);
    const store = new EditorStore({ initMd: md, editable: true, mode: "rich" });
    const root = createRoot(host);
    root.render(
        <DOMDProvider store={store}>
            <DOMD />
        </DOMDProvider>,
    );
    await tick(200);
    const editor = host.querySelector<HTMLElement>("[contenteditable]");
    if (!editor) throw new Error("editor did not mount");
    editor.focus();
    await tick();
    return {
        store,
        host,
        unmount: () => {
            root.unmount();
            host.remove();
        },
    };
};

/** Put the model caret at an absolute markdown offset and let it replay. */
const caretAt = async (store: EditorStore, offset: number) => {
    const result = store.setSelection({ start: offset });
    await tick();
    return result.applied;
};

const describe = (node: Node | null) =>
    !node
        ? "null"
        : node.nodeType === Node.TEXT_NODE
          ? `text(${JSON.stringify(node.textContent)})`
          : `<${node.nodeName.toLowerCase()}${
                (node as Element).hasAttribute("data-domd-filler") ? " filler" : ""
            }${(node as Element).hasAttribute("data-domd-hard-break") ? " hard-break" : ""}>`;

const anchor = () => {
    const selection = document.getSelection();
    return {
        node: selection?.anchorNode ?? null,
        offset: selection?.anchorOffset ?? -1,
    };
};

/** Top of the line the browser paints the caret on. */
const caretTop = (): number => {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return Number.NaN;
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    if (rects.length) return Math.round(rects[0].top);
    const node = selection.anchorNode;
    if (node && node.nodeType === Node.ELEMENT_NODE) {
        return Math.round((node as Element).getBoundingClientRect().top);
    }
    return Math.round(range.getBoundingClientRect().top);
};

/** Top of the line the first occurrence of `char` in `scope` sits on. */
const charTop = (scope: Element, char: string): number => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const index = node.textContent?.indexOf(char) ?? -1;
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return Math.round(range.getBoundingClientRect().top);
    }
    return Number.NaN;
};

const typeNative = async (text: string) => {
    document.execCommand("insertText", false, text);
    await tick(150);
};

const press = async (key: string, init: KeyboardEventInit = {}) => {
    const target =
        (document.getSelection()?.anchorNode as Node | null)?.parentElement ??
        document.activeElement;
    target?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
    await tick(150);
};

/** An IME commit through the kernel's composition path: compositionstart
 *  snapshots the DOM caret, compositionend inserts `data` there. */
const compose = async (data: string) => {
    const target =
        (document.getSelection()?.anchorNode as Node | null)?.parentElement ??
        document.activeElement;
    target?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await tick(20);
    target?.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, cancelable: true, data }),
    );
    await tick(150);
};

const tableDoc = (cell: string) =>
    ["intro", "", "| head | x |", "| ---- | - |", `| ${cell} | y |`].join("\n");

const tableRows = (md: string) => md.split("\n").filter((l) => l.startsWith("|")).length;

const cases: Array<[string, () => Promise<void>]> = [
    [
        "paragraph: caret after a mid-line <br>",
        async () => {
            const { store, host, unmount } = await mount("第一行<br>第二行");
            check("p-mid: setSelection applied", await caretAt(store, 7));
            const at = anchor();
            check(
                "p-mid: DOM caret at the start of line 2",
                at.node?.nodeType === Node.TEXT_NODE && at.node.textContent === "第二行" && at.offset === 0,
                { node: describe(at.node), offset: at.offset },
            );
            check("p-mid: caret painted on line 2", caretTop() === charTop(host, "二"), {
                caret: caretTop(),
                line1: charTop(host, "一"),
                line2: charTop(host, "二"),
            });
            await typeNative("X");
            check("p-mid: native typing lands on line 2", store.toMarkdown() === "第一行<br>X第二行", store.toMarkdown());
            unmount();
        },
    ],
    [
        "paragraph: caret after a trailing <br>",
        async () => {
            const { store, unmount } = await mount("第一行<br>");
            check("p-tail: setSelection applied", await caretAt(store, 7));
            const at = anchor();
            check(
                "p-tail: DOM caret on the filler line",
                at.node?.nodeName === "BR" && (at.node as Element).hasAttribute("data-domd-filler"),
                { node: describe(at.node), offset: at.offset },
            );
            await typeNative("X");
            check("p-tail: native typing lands on line 2", store.toMarkdown() === "第一行<br>X", store.toMarkdown());
            unmount();
        },
    ],
    [
        "paragraph: backspace after <br>",
        async () => {
            const { store, unmount } = await mount("第一行<br>第二行");
            await caretAt(store, 7);
            await press("Backspace");
            check("p-backspace: deletes the break whole", store.toMarkdown() === "第一行第二行", store.toMarkdown());
            unmount();
        },
    ],
    [
        "cell: Enter mid-cell",
        async () => {
            const { store, host, unmount } = await mount(tableDoc("ab"));
            const md = store.toMarkdown();
            await caretAt(store, md.indexOf("| ab") + 3);
            await press("Enter");
            const after = store.toMarkdown();
            check("cell-enter: written <br>", after.includes("| a<br>b"), after);
            check("cell-enter: table intact", tableRows(after) === 3, after);
            const td = host.querySelectorAll("td")[0];
            check("cell-enter: no literal tag in the cell DOM", !td.textContent?.includes("<br>"), td.textContent);
            check("cell-enter: cell renders two lines", charTop(td, "b") > charTop(td, "a"), {
                a: charTop(td, "a"),
                b: charTop(td, "b"),
            });
            check("cell-enter: caret painted on line 2", caretTop() === charTop(td, "b"), {
                caret: caretTop(),
                at: describe(anchor().node),
                offset: anchor().offset,
            });
            await typeNative("X");
            check("cell-enter: native typing lands on line 2", store.toMarkdown().includes("| a<br>Xb"), store.toMarkdown());
            unmount();
        },
    ],
    [
        "cell: Enter at the end of a cell",
        async () => {
            const { store, host, unmount } = await mount(tableDoc("ab"));
            const md = store.toMarkdown();
            await caretAt(store, md.indexOf("| ab") + 4);
            await press("Enter");
            check("cell-tail: written <br>", store.toMarkdown().includes("| ab<br>"), store.toMarkdown());
            const td = host.querySelectorAll("td")[0];
            check("cell-tail: caret below the text", caretTop() > charTop(td, "a"), {
                caret: caretTop(),
                a: charTop(td, "a"),
                at: describe(anchor().node),
            });
            await typeNative("Y");
            check("cell-tail: native typing lands on line 2", store.toMarkdown().includes("| ab<br>Y"), store.toMarkdown());
            unmount();
        },
    ],
    [
        "cell: Shift+Enter",
        async () => {
            const { store, unmount } = await mount(tableDoc("ab"));
            const md = store.toMarkdown();
            await caretAt(store, md.indexOf("| ab") + 3);
            await press("Enter", { shiftKey: true });
            check("cell-shift-enter: written <br>", store.toMarkdown().includes("| a<br>b"), store.toMarkdown());
            check("cell-shift-enter: table intact", tableRows(store.toMarkdown()) === 3, store.toMarkdown());
            unmount();
        },
    ],
    [
        "cell: Backspace at the start of line 2",
        async () => {
            const { store, unmount } = await mount(tableDoc("a<br>b"));
            const md = store.toMarkdown();
            await caretAt(store, md.indexOf("a<br>b") + "a<br>".length);
            await press("Backspace");
            check("cell-backspace: joins the lines", store.toMarkdown().includes("| ab "), store.toMarkdown());
            check("cell-backspace: table intact", tableRows(store.toMarkdown()) === 3, store.toMarkdown());
            unmount();
        },
    ],
    [
        "IME commit after a break",
        async () => {
            const paragraph = await mount("第一行<br>第二行");
            await caretAt(paragraph.store, 7);
            await compose("中");
            check(
                "ime-paragraph: committed text lands on line 2",
                paragraph.store.toMarkdown() === "第一行<br>中第二行",
                paragraph.store.toMarkdown(),
            );
            paragraph.unmount();

            const cell = await mount(tableDoc("ab"));
            const md = cell.store.toMarkdown();
            await caretAt(cell.store, md.indexOf("| ab") + 3);
            await press("Enter");
            await compose("中");
            check(
                "ime-cell: committed text lands on line 2",
                cell.store.toMarkdown().includes("| a<br>中b"),
                cell.store.toMarkdown(),
            );
            cell.unmount();
        },
    ],
    [
        "cell: Enter inside a code span",
        async () => {
            const { store, unmount } = await mount(tableDoc("`ab`"));
            const before = store.toMarkdown();
            await caretAt(store, before.indexOf("`ab`") + 2);
            await press("Enter");
            check("cell-code: Enter is a no-op", store.toMarkdown() === before, store.toMarkdown());
            unmount();
        },
    ],
];

const run = async () => {
    for (const [name, body] of cases) {
        try {
            await body();
        } catch (error) {
            failures += 1;
            lines.push(`FAIL ${name}: threw ${String(error)}`);
        }
    }
    lines.push(`${passes} passed, ${failures} failed`);
    const out = document.getElementById("out");
    if (out) out.textContent = lines.join("\n");
};

void run();
