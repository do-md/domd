/**
 * Headless contract matrix for opt-in local-file candidates.
 * Run: sh scripts/verify-file-paths/run.sh
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
    DOMD,
    DOMDProvider,
    EditorStore,
    MarkdownType,
    RenderChildren,
    getFilePathInfo,
    getRenderElementProps,
    getSpanRenderIdProps,
    serializeRenderData,
    viewOnlyProps,
} from "../../src";
import type { AnyRenderData, FilePathInfo, RenderElementProps } from "../../src";

let passes = 0;
let failures = 0;

const check = (name: string, condition: boolean, detail?: unknown) => {
    if (condition) {
        passes += 1;
        return;
    }
    failures += 1;
    console.error(`FAIL: ${name}`, detail ?? "");
};

const walk = (node: AnyRenderData, out: AnyRenderData[] = []): AnyRenderData[] => {
    if (node.htmlType_ === MarkdownType.FilePath) out.push(node);
    for (const child of node.children_ ?? []) walk(child, out);
    return out;
};

// htmlType_ chains from the root to every FilePath node.
const ancestry = (
    node: AnyRenderData,
    chain: string[] = [],
    out: string[][] = [],
): string[][] => {
    if (node.htmlType_ === MarkdownType.FilePath) out.push(chain);
    for (const child of node.children_ ?? []) {
        ancestry(child, [...chain, String(node.htmlType_)], out);
    }
    return out;
};

const countType = (node: AnyRenderData, type: MarkdownType): number =>
    (node.htmlType_ === type ? 1 : 0) +
    (node.children_ ?? []).reduce((sum, child) => sum + countType(child, type), 0);

const infos = (store: EditorStore): FilePathInfo[] =>
    walk(store.state.renderData_)
        .map(getFilePathInfo)
        .filter((value): value is FilePathInfo => value !== null);

const createStore = (initMd: string, filePaths = true) =>
    new EditorStore({ initMd, editable: true, filePaths });

// Default-off compatibility: bytes and tree shape remain the legacy plain text.
{
    const md = "Open /tmp/a.pdf and reports/a.csv";
    const store = createStore(md, false);
    check("off: no FilePath nodes", infos(store).length === 0);
    check("off: byte-exact round trip", store.toMarkdown() === md, store.toMarkdown());
}

// Supported forms, Unicode, balanced parentheses, quoted spaces and two location syntaxes.
{
    const md = [
        "/tmp/demo.png,",
        "/Volumes/素材/演示.mp4。",
        "~/Downloads/voice.m4a",
        "./reports/run.pdf",
        "../docs/a.md",
        "reports/a.csv",
        "file:///tmp/demo.png",
        "file://localhost/tmp/a.txt",
        "/tmp/设计(终稿).png。",
        '"/tmp/Project Files/final cut.mov"',
        "/tmp/a.ts:12:3",
        "./src/a.ts#L8C2",
        "/tmp/no-extension",
        '"custom folder/final cut.mov"',
    ].join(" ");
    const store = createStore(md);
    const found = infos(store);
    check("matrix: all candidates found", found.length === 14, found);
    check("matrix: byte-exact round trip", store.toMarkdown() === md, store.toMarkdown());
    check(
        "matrix: Chinese balanced path excludes sentence punctuation",
        found.some((item) => item.raw === "/tmp/设计(终稿).png"),
        found,
    );
    check(
        "matrix: quoted spaces preserved",
        found.some((item) => item.path === "/tmp/Project Files/final cut.mov") &&
            found.some((item) => item.path === "custom folder/final cut.mov"),
        found,
    );
    check(
        "matrix: colon location split",
        found.some(
            (item) =>
                item.raw === "/tmp/a.ts:12:3" &&
                item.path === "/tmp/a.ts" &&
                item.line === 12 &&
                item.column === 3,
        ),
        found,
    );
    check(
        "matrix: hash location split",
        found.some(
            (item) =>
                item.path === "./src/a.ts" && item.line === 8 && item.column === 2,
        ),
        found,
    );
    check(
        "matrix: file URI stays encoded and unresolved",
        found.some(
            (item) => item.kind === "file-uri" && item.path === "file:///tmp/demo.png",
        ),
        found,
    );
}

// Existing Markdown constructs own their contents; URLs and ambiguous routes stay out.
for (const [name, md] of [
    ["markdown link", "[report](/tmp/a.pdf)"],
    ["path as link text", "[/tmp/a.png](https://example.com)"],
    ["relative path in link text", "[see ./a.md](https://example.com)"],
    ["markdown image", "![image](/tmp/a.png)"],
    ["inline code", "`/tmp/a.pdf`"],
    ["fenced code", "```diff\n+ /tmp/a.pdf\n```"],
    ["bare URL", "https://example.com/tmp/a.png"],
    ["escaped example", "\\/tmp/a.pdf"],
    ["site routes", "/api/sessions /login"],
    ["ambiguous prose", "ratio a/b and ordinary words"],
] as const) {
    const store = createStore(md);
    check(`${name}: no FilePath`, infos(store).length === 0, infos(store));
    check(`${name}: round trip`, store.toMarkdown() === md, store.toMarkdown());
}

// Link text gets no autolinks of either kind: links may not nest (GFM).
{
    const md = "[https://a.example](https://b.example) and https://c.example";
    for (const filePaths of [false, true]) {
        const store = createStore(md, filePaths);
        check(
            `link text (filePaths=${filePaths}): no nested bare-URL link`,
            countType(store.state.renderData_, MarkdownType.Link) === 2,
            countType(store.state.renderData_, MarkdownType.Link),
        );
        check(`link text (filePaths=${filePaths}): round trip`, store.toMarkdown() === md);
    }
}

// Sentence punctuation must delimit an unquoted candidate without swallowing
// adjacent prose. Quoted candidates may contain the same punctuation as data.
// Whitespace always ends an unquoted candidate; quoting is the only way to
// include it, and quoted prose that is not a path falls back to the unquoted
// reading.
for (const [name, md, expected] of [
    [
        "full-width colon",
        "请看对比图：/tmp/comparison.png。",
        [{ raw: "/tmp/comparison.png", path: "/tmp/comparison.png", kind: "absolute" }],
    ],
    [
        "nested prose before colon",
        "说明：请看图片（上旧下新）：/tmp/comparison.png。",
        [{ raw: "/tmp/comparison.png", path: "/tmp/comparison.png", kind: "absolute" }],
    ],
    [
        "full-width comma and period",
        "说明，资料/对比图.png。",
        [{ raw: "资料/对比图.png", path: "资料/对比图.png", kind: "relative" }],
    ],
    [
        "multiple forms without spaces",
        "绝对：/tmp/a.png，相对：../图/b.jpg，主目录：~/资料/c.txt，文件URI：file:///tmp/d.pdf。",
        [
            { raw: "/tmp/a.png", path: "/tmp/a.png", kind: "absolute" },
            { raw: "../图/b.jpg", path: "../图/b.jpg", kind: "relative" },
            { raw: "~/资料/c.txt", path: "~/资料/c.txt", kind: "home" },
            { raw: "file:///tmp/d.pdf", path: "file:///tmp/d.pdf", kind: "file-uri" },
        ],
    ],
    [
        "Chinese quoted spaces and balanced parentheses",
        '路径："资料（旧）/对比 图(终稿).png"。',
        [{ raw: "资料（旧）/对比 图(终稿).png", path: "资料（旧）/对比 图(终稿).png", kind: "relative" }],
    ],
    [
        "quoted punctuation in a legal name",
        '路径："资料，旧/对比图.png"。',
        [{ raw: "资料，旧/对比图.png", path: "资料，旧/对比图.png", kind: "relative" }],
    ],
    [
        "double quote glued to adjacent text",
        '另见"资料/对比 图.png"查看',
        [{ raw: "资料/对比 图.png", path: "资料/对比 图.png", kind: "relative" }],
    ],
    [
        "glued double quote is a boundary of the unquoted reading",
        '另见"资料/a.png"',
        [{ raw: "资料/a.png", path: "资料/a.png", kind: "relative" }],
    ],
    [
        "curly quotes glued to adjacent text",
        "请打开“/tmp/a.png”查看",
        [{ raw: "/tmp/a.png", path: "/tmp/a.png", kind: "absolute" }],
    ],
    [
        "curly quotes delimit a space-bearing path",
        "see “/Users/me/My Docs/a.pdf”.",
        [{ raw: "/Users/me/My Docs/a.pdf", path: "/Users/me/My Docs/a.pdf", kind: "absolute" }],
    ],
    [
        "curly apostrophe is not a quote",
        "it’s ../a.md",
        [{ raw: "../a.md", path: "../a.md", kind: "relative" }],
    ],
    [
        "prose after an extensionless directory",
        "Run in /tmp/build then open index.html now",
        [{ raw: "/tmp/build", path: "/tmp/build", kind: "absolute" }],
    ],
    [
        "prose after a home directory",
        "see ~/proj and then edit main.ts later",
        [{ raw: "~/proj", path: "~/proj", kind: "home" }],
    ],
    ["lone slash in prose", "Use / to separate. Then open README.md now", []],
    ["fraction in prose", "the ratio is 1/2 of the file.txt here", []],
    ["and/or in prose", "read and/or write config.json today", []],
    ["date in prose", "on 2024/01/02 we shipped v1.2.md", []],
    [
        "unquoted space ends the candidate",
        "Open /Users/me/My Documents/report final.pdf please",
        [{ raw: "/Users/me/My", path: "/Users/me/My", kind: "absolute" }],
    ],
    [
        "quoted space-bearing absolute path",
        'Open "/Users/me/My Documents/report final.pdf" please',
        [{
            raw: "/Users/me/My Documents/report final.pdf",
            path: "/Users/me/My Documents/report final.pdf",
            kind: "absolute",
        }],
    ],
    [
        "quoted prose falls back to the unquoted reading",
        'He said "check ./a.md first" ok',
        [{ raw: "./a.md", path: "./a.md", kind: "relative" }],
    ],
    [
        "quoted prose starting with a path",
        '"docs/a.md is the file"',
        [{ raw: "docs/a.md", path: "docs/a.md", kind: "relative" }],
    ],
    [
        "unclosed quote opens nothing",
        'He said "open /tmp/a.png and more',
        [{ raw: "/tmp/a.png", path: "/tmp/a.png", kind: "absolute" }],
    ],
    [
        "apostrophe is not a quote",
        "it's ../a.md",
        [{ raw: "../a.md", path: "../a.md", kind: "relative" }],
    ],
    [
        "trailing colon",
        "Saved to /tmp/a.png: done, see src/a.ts:12: too",
        [
            { raw: "/tmp/a.png", path: "/tmp/a.png", kind: "absolute" },
            { raw: "src/a.ts:12", path: "src/a.ts", kind: "relative" },
        ],
    ],
] as const) {
    const store = createStore(md);
    const found = infos(store).map(({ raw, path, kind }) => ({ raw, path, kind }));
    check(`${name}: exact candidates`, JSON.stringify(found) === JSON.stringify(expected), found);
    check(`${name}: round trip`, store.toMarkdown() === md, store.toMarkdown());
}

// Emphasis delimiters belong to the inline grammar: the candidate forms inside
// the emphasis instead of swallowing its delimiters.
for (const [name, md, raw, wrapper] of [
    ["strong emphasis", "**/tmp/a.png**", "/tmp/a.png", MarkdownType.Bold],
    ["emphasis around prose", "*see ./a.md*", "./a.md", MarkdownType.Em],
] as const) {
    const store = createStore(md);
    const found = infos(store);
    check(
        `${name}: exact candidate`,
        found.length === 1 && found[0].raw === raw,
        found,
    );
    check(
        `${name}: candidate nested in the emphasis`,
        ancestry(store.state.renderData_).some((chain) => chain.includes(wrapper)),
        ancestry(store.state.renderData_),
    );
    check(`${name}: round trip`, store.toMarkdown() === md, store.toMarkdown());
}

// Stable public data: no host walk through private tree fields is required.
{
    const store = createStore("See ../src/main.ts:9");
    const node = walk(store.state.renderData_)[0];
    const info = node && getFilePathInfo(node);
    const json = node && serializeRenderData(node);
    check(
        "public helper: exact payload",
        !!info &&
            info.raw === "../src/main.ts:9" &&
            info.path === "../src/main.ts" &&
            info.line === 9,
        info,
    );
    check(
        "serialized props: stable path payload",
        json?.type === MarkdownType.FilePath &&
            json.props["data-file-path"] === "../src/main.ts",
        json,
    );
}

// Renderer override follows the universal root/children/view-only contract.
{
    const PathCandidate = ({ parsedData }: RenderElementProps) => {
        const info = getFilePathInfo(parsedData);
        return (
            <span
                {...getRenderElementProps(parsedData)}
                {...getSpanRenderIdProps(parsedData)}
                data-test="path-candidate"
                data-candidate-path={info?.path}
            >
                <RenderChildren parsedData={parsedData} />
                <span {...viewOnlyProps}>path</span>
            </span>
        );
    };
    const html = renderToStaticMarkup(
        <DOMDProvider
            editable={false}
            initMd="Open /tmp/demo.pdf"
            filePaths
            renderComponent={{ [MarkdownType.FilePath]: PathCandidate }}
        >
            <DOMD />
        </DOMDProvider>,
    );
    check("renderer: override dispatched", html.includes('data-test="path-candidate"'), html);
    check("renderer: public path available", html.includes('data-candidate-path="/tmp/demo.pdf"'), html);
    check("renderer: editable source retained", html.includes("/tmp/demo.pdf"), html);
    check("renderer: decoration marked view-only", html.includes("data-domd-view-only"), html);
}

// Same store, character and chunk appends converge to the one-shot parse.
const stream = (chunks: string[]): EditorStore => {
    const store = createStore("prefix ");
    for (const chunk of chunks) {
        const placed = store.setSelection({ start: store.toMarkdown().length });
        check(`stream: place before ${JSON.stringify(chunk)}`, placed.applied, placed);
        store.insertText(chunk);
    }
    return store;
};

const streamDocument = (chunks: string[]): EditorStore => {
    const store = createStore("");
    for (const chunk of chunks) {
        const placed = store.setSelection({ start: store.toMarkdown().length });
        check(`document stream: place before ${JSON.stringify(chunk)}`, placed.applied, placed);
        store.insertText(chunk);
    }
    return store;
};

for (const [label, path, pieces] of [
    ["unquoted", "/tmp/partial-name.mp4:18:2", ["/tmp/par", "tial-name", ".mp4", ":18:2"]],
    // Until the closing quote arrives the unquoted reading applies; the quoted
    // reading must take over and converge once it does.
    ["quoted", '"/tmp/partial name.mp4:18:2"', ['"/tmp/par', "tial name", ".mp4", ':18:2"']],
] as const) {
    const once = createStore(`prefix ${path}`);
    const chars = stream([...path]);
    const chunks = stream([...pieces]);
    for (const [name, store] of [
        [`${label} char`, chars],
        [`${label} chunk`, chunks],
    ] as const) {
        check(`${name}: final markdown matches one-shot`, store.toMarkdown() === once.toMarkdown(), store.toMarkdown());
        check(`${name}: final public payload matches`, JSON.stringify(infos(store)) === JSON.stringify(infos(once)), infos(store));
        check(`${name}: exactly one candidate`, infos(store).length === 1, infos(store));
    }
}

{
    const md = '说明：请看图片（上旧下新）：/tmp/comparison.png。另见"资料/对比 图(终稿).png"。';
    const once = createStore(md);
    const chars = streamDocument([...md]);
    const chunks = streamDocument([
        "说明：请看图片（上旧下新）：/tmp/com",
        'parison.png。另见"',
        "资料/对比 图(终稿)",
        '.png"。',
    ]);
    for (const [name, store] of [
        ["punctuation char stream", chars],
        ["punctuation chunk stream", chunks],
    ] as const) {
        check(`${name}: markdown matches static`, store.toMarkdown() === once.toMarkdown(), store.toMarkdown());
        check(`${name}: payload matches static`, JSON.stringify(infos(store)) === JSON.stringify(infos(once)), infos(store));
    }
}

// Completing a recognized prefix goes through the ordinary span merge: the
// candidate is replaced as one atomic subtree, so its payload is re-derived
// together with its text and can never disagree with it.
{
    const store = createStore("/tmp/partial");
    check("completion: prefix is already a candidate", infos(store).length === 1, infos(store));
    const placed = store.setSelection({ start: store.toMarkdown().length });
    check("completion: caret placed", placed.applied, placed);
    store.insertText(".mp4");
    const found = infos(store);
    check(
        "completion: one candidate whose payload matches its text",
        found.length === 1 &&
            found[0].raw === "/tmp/partial.mp4" &&
            found[0].path === "/tmp/partial.mp4",
        found,
    );
}

console.log(`verify-file-paths: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
