/**
 * Model-residency memory benchmark for the DOMD kernel (headless).
 *
 * Question under test: with a "full text resident + virtualized rendering"
 * architecture the parsed model stays fully resident — how much heap does
 * the EditorStore model actually take for a document of a given size and
 * content profile? (Known prior data point: 595KB text -> ~42MB heap.)
 *
 * One case per process (fresh V8 heap, no cross-case fragmentation):
 *
 *   node --expose-gc --max-old-space-size=8192 --experimental-strip-types \
 *        --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/bench-model-memory/run.mts --profile mixed --mb 10
 *
 * Prints a single JSON line with the measurements.
 *
 * Method: settle GC -> heap baseline -> generate text (bytes recorded) ->
 * resetMD(text) (synchronous full parse; the >500-line chunked path only
 * exists on the constructor) -> drop the text reference -> settle GC ->
 * model heap = heapUsed - baseline. This keeps any parent strings retained
 * by V8 sliced strings inside the measurement, which matches real app
 * retention (the file content string is released after parse there too).
 */
import { EditorStore } from "@do-md/core-react";

type Profile = "prose" | "code" | "code-prism" | "table" | "list" | "mixed";

const args = process.argv.slice(2);
const readArg = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const profile = readArg("profile", "mixed") as Profile;
const targetMB = Number(readArg("mb", "2"));
const targetBytes = Math.round(targetMB * 1024 * 1024);

const gcRef = (globalThis as { gc?: () => void }).gc;
if (!gcRef) {
    console.error("run with --expose-gc");
    process.exit(1);
}
const settleGC = async () => {
    for (let i = 0; i < 4; i++) {
        gcRef();
        await new Promise((r) => setImmediate(r));
    }
};
const heap = () => process.memoryUsage().heapUsed;

// ---------------------------------------------------------------- generators
// Deterministic unit generators (no randomness); each unit is a few complete
// top-level blocks. Units repeat until the byte budget is reached.

const proseUnit = (i: number) => `## Section ${i}: measurement prose

The quick brown fox ${i} jumps over the lazy dog while **bold claims** and
*italic asides* accumulate spans, with an inline \`heapUsed\` reference and a
[link](https://example.com/page-${i}) that parses into a Link node,
soft-wrapped across three source lines before the paragraph ends.

A second, shorter paragraph follows with ~~struck text~~ and a plain tail so
the block mix is not a single shape.

`;

const codeUnit = (i: number) => `### Snippet ${i}

\`\`\`js
function benchCase${i}(input) {
    const total = input.reduce((acc, n) => acc + n, 0);
    const label = "case-${i}";
    if (total > ${i % 97}) {
        console.log(label, total);
    }
    for (let k = 0; k < input.length; k++) {
        input[k] = input[k] * 2 + ${i % 7};
    }
    return { label, total };
}
\`\`\`

Short interlude paragraph ${i} between fences.

`;

const tableRow = (i: number, r: number) =>
    `| cell-${i}-${r}-a | value ${r * 3 + 1} | value ${r * 3 + 2} | note ${i} | flag-${r % 2} |`;
const tableUnit = (i: number) => {
    const rows = Array.from({ length: 12 }, (_, r) => tableRow(i, r)).join("\n");
    return `### Table ${i}

| Name | Alpha | Beta | Notes | Flag |
| --- | --- | --- | --- | --- |
${rows}

Paragraph after table ${i}.

`;
};

const listUnit = (i: number) => `### List ${i}

- top item one of unit ${i} with some trailing prose
- top item two with **bold** content
  - nested child a
  - nested child b with a [link](https://example.com/${i})
- top item three

1. ordered first ${i}
2. ordered second with \`code\`
3. ordered third
   1. nested ordered child
   2. another nested child

> A short blockquote closing unit ${i}, spanning
> two source lines with markers on both.

`;

const buildDoc = (kind: Profile): string => {
    const parts: string[] = ["# Benchmark document\n\n"];
    let bytes = parts[0].length;
    let i = 0;
    const push = (s: string) => {
        parts.push(s);
        bytes += s.length; // ASCII-only generators: length === bytes
    };
    while (bytes < targetBytes) {
        i += 1;
        switch (kind) {
            case "prose":
                push(proseUnit(i));
                break;
            case "code":
            case "code-prism":
                push(codeUnit(i));
                break;
            case "table":
                push(tableUnit(i));
                break;
            case "list":
                push(listUnit(i));
                break;
            case "mixed":
                // Roughly: half prose, then code / list / table sprinkled in.
                push(proseUnit(i));
                if (i % 2 === 0) push(codeUnit(i));
                if (i % 3 === 0) push(listUnit(i));
                if (i % 5 === 0) push(tableUnit(i));
                break;
        }
    }
    return parts.join("");
};

// ------------------------------------------------------------------ measure
const main = async () => {
    let codeTokenizer: ((code: string, lang?: string) => unknown[]) | undefined;
    if (profile === "code-prism") {
        // common/lib/prism.ts uses extension-less deep imports (bundler
        // style) that Node ESM cannot resolve, so wire Prism directly here.
        // The generator only emits ```js fences; one grammar is enough.
        const { default: Prism } = await import("prismjs");
        await import("prismjs/components/prism-javascript.js" as string);
        codeTokenizer = (code: string, lang?: string) => {
            const grammar = lang ? Prism.languages[lang] : undefined;
            return grammar ? (Prism.tokenize(code, grammar) as unknown[]) : [];
        };
    }

    await settleGC();
    const h0 = heap();

    let text: string | null = buildDoc(profile);
    const textBytes = text.length;
    const lines = (text.match(/\n/g) ?? []).length + 1;

    await settleGC();
    const hText = heap();

    const store = new EditorStore({
        editable: true,
        initMd: "",
        ...(codeTokenizer ? { codeTokenizer } : {}),
    } as ConstructorParameters<typeof EditorStore>[0]);

    await settleGC();
    const hStore = heap();

    const t0 = performance.now();
    store.resetMD(text);
    const parseMs = performance.now() - t0;

    text = null; // release the source string; slices may retain parents — measured
    await settleGC();
    const hModel = heap();

    const t1 = performance.now();
    let md: string | null = store.toMarkdown();
    const toMarkdownMs = performance.now() - t1;
    const roundTripBytes = md.length;
    md = null;

    let topLevelBlocks: number | null = null;
    try {
        const root = (store as unknown as {
            renderData_?: { children_?: unknown[] };
        }).renderData_;
        topLevelBlocks = root?.children_?.length ?? null;
    } catch {
        topLevelBlocks = null;
    }

    await settleGC();
    const hAfterSerialize = heap();

    const result = {
        profile,
        targetMB,
        textBytes,
        textMB: +(textBytes / 1024 / 1024).toFixed(2),
        lines,
        topLevelBlocks,
        parseMs: +parseMs.toFixed(1),
        toMarkdownMs: +toMarkdownMs.toFixed(1),
        roundTripBytes,
        roundTripDelta: roundTripBytes - textBytes,
        textHeapMB: +((hText - h0) / 1024 / 1024).toFixed(2),
        emptyStoreHeapMB: +((hStore - hText) / 1024 / 1024).toFixed(2),
        modelHeapMB: +((hModel - hStore) / 1024 / 1024).toFixed(2),
        amplification: +(((hModel - hStore) / textBytes) ).toFixed(1),
        serializeResidueMB: +((hAfterSerialize - hModel) / 1024 / 1024).toFixed(2),
        rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(0),
    };
    console.log(JSON.stringify(result));
};

main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
});
