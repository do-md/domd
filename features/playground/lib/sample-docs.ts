export type SampleDoc = {
    id: string;
    label: string;
    description: string;
    lines: number;
    content: string | (() => string);
};

const ARTICLE = `# Streaming Markdown is a different input model

When humans write Markdown, they type a sentence, paste a paragraph, or edit
an existing document. The input arrives in roughly *whole* shapes — a
heading, a bullet, a finished paragraph.

When an AI writes Markdown, the input arrives **token by token**, split at
arbitrary positions. A code fence may open before its language tag is
complete. A list item may start with just a \`-\` and a space.

> A useful editor for the AI era should treat streaming Markdown as a
> first-class input mode — not an artifact of the chat UI layer.

## What DOMD tries to prove

1. A WYSIWYG Markdown core can stay small (~20 KB gzipped).
2. The same core can handle preview, edit, and stream.
3. Streaming output should remain **editable** while the stream is running.

## Try it

- Pick a document
- Pick a chunk size and delay
- Press **Start streaming**
- Click anywhere in the editor — it stays editable while streaming

\`\`\`ts
window.mockAI = async (text: string) => {
    let i = 0;
    while (i < text.length) {
        const size = 1 + Math.floor(Math.random() * 5);
        store?.insertText(text.slice(i, i + size));
        i += size;
        await sleep(25 + Math.random() * 35);
    }
};
\`\`\`

That's the whole streaming loop. DOMD does the rest.
`;

const LONG_LIST = (() => {
    const lines = ["# A long ordered list\n"];
    lines.push("This list has 200 items. Streaming it tests how the engine");
    lines.push("handles incremental list-item parsing.\n");
    for (let i = 1; i <= 200; i++) {
        lines.push(`${i}. Item number ${i} — a line about something at row ${i}.`);
    }
    return lines.join("\n");
})();

const CODE_HEAVY = `# Code-heavy document

A document with multiple fenced code blocks in different languages.

## TypeScript

\`\`\`ts
type Block = { id: string; type: BlockType; children: Block[] };

export function walk(root: Block, visit: (b: Block) => void): void {
    visit(root);
    for (const child of root.children) walk(child, visit);
}
\`\`\`

## Rust

\`\`\`rust
pub struct Editor {
    doc: Document,
    selection: Range,
}

impl Editor {
    pub fn insert(&mut self, text: &str) {
        let range = self.selection.clone();
        self.doc.replace_range(range, text);
        self.selection.collapse_to_end();
    }
}
\`\`\`

## Python

\`\`\`python
def stream_markdown(text: str, chunk: int = 4):
    for i in range(0, len(text), chunk):
        yield text[i : i + chunk]
\`\`\`

## Shell

\`\`\`sh
curl -s https://example.com/doc.md \\
    | jq -r '.content' \\
    | domd --stream
\`\`\`

## JSON

\`\`\`json
{
    "name": "domd",
    "version": "0.2.2",
    "core": "20kb"
}
\`\`\`
`;

const TABLES = `# Tables and structured data

A few tables of different shapes — streaming a table is tricky because the
header row only becomes a table once the separator row arrives.

## Comparison

| Engine | Core size | Streaming | WYSIWYG |
| --- | --- | --- | --- |
| DOMD | ~20 KB | yes | yes |
| ProseMirror | ~130 KB | partial | yes |
| Slate | ~80 KB | manual | yes |
| Lexical | ~70 KB | manual | yes |
| react-markdown | ~30 KB | preview only | no |

## Benchmarks

| Document | Lines | Chunk | Result |
| --- | --- | --- | --- |
| Short article | 30 | 1–5 chars | smooth |
| Long list | 200 | 1–5 chars | smooth |
| Code-heavy | 80 | word | smooth |
| Huge doc | 20,000 | 1–5 chars | editable while streaming |

## Notes

- Tables remain editable mid-stream.
- The header row renders as a paragraph until the separator arrives.
- Long rows wrap inside cells without breaking layout.
`;

const NESTED = `# Complex nested structures

> ## A nested heading inside a blockquote
>
> Blockquotes can hold their own structure.
>
> 1. First nested item
>    - Sub-item A
>    - Sub-item B with **bold** and *italic*
>      - Deeper still
>        - Even deeper
> 2. Second item with code: \`store.insertText(chunk)\`
> 3. Third item with a fence:
>
>    \`\`\`ts
>    function pump() {
>        return chunks.next();
>    }
>    \`\`\`

---

## Mixed list

- Top-level bullet
    - Nested with a [link](https://github.com/do-md/domd)
    - Nested with **bold** text
        1. Ordered inside unordered
        2. Another ordered item
- Another top-level
    > Quote inside a list item.
    >
    > With multiple lines.

## Task list

- [x] Build a 20 KB core
- [x] Support streaming input
- [ ] Ship the playground
- [ ] Record a 30-second demo
`;

function buildHuge(targetLines: number): string {
    const out: string[] = [];
    out.push("# A huge streaming stress test\n");
    out.push(
        `This document is generated at ~${targetLines.toLocaleString()} lines to`,
    );
    out.push("stress the engine while AI-style chunks arrive continuously.\n");

    let line = 0;
    let section = 0;
    while (line < targetLines) {
        section++;
        out.push(`## Section ${section}\n`);
        line += 2;

        const paraLen = 4 + Math.floor(Math.random() * 4);
        for (let i = 0; i < paraLen && line < targetLines; i++) {
            out.push(
                `Sentence ${i + 1} of section ${section}. Streaming is just a` +
                    ` sequence of tiny chunks, and the engine reparses what it` +
                    ` needs to.`,
            );
            line++;
        }
        out.push("");
        line++;

        if (section % 3 === 0 && line < targetLines) {
            out.push("```ts");
            out.push(`// section ${section} sample`);
            out.push(`export const id = ${section};`);
            out.push("```\n");
            line += 5;
        }

        if (section % 4 === 0 && line < targetLines) {
            const listLen = 5 + Math.floor(Math.random() * 6);
            for (let i = 0; i < listLen && line < targetLines; i++) {
                out.push(`- bullet ${i + 1} in section ${section}`);
                line++;
            }
            out.push("");
            line++;
        }
    }

    return out.join("\n");
}

export const SAMPLE_DOCS: SampleDoc[] = [
    {
        id: "article",
        label: "Article",
        description: "Mixed prose, lists, and one code fence.",
        lines: ARTICLE.split("\n").length,
        content: ARTICLE,
    },
    {
        id: "list",
        label: "Long list (200)",
        description: "200 ordered items — incremental list parsing.",
        lines: LONG_LIST.split("\n").length,
        content: LONG_LIST,
    },
    {
        id: "code",
        label: "Code-heavy",
        description: "Multiple fenced code blocks across languages.",
        lines: CODE_HEAVY.split("\n").length,
        content: CODE_HEAVY,
    },
    {
        id: "tables",
        label: "Tables",
        description: "Comparison and benchmark tables.",
        lines: TABLES.split("\n").length,
        content: TABLES,
    },
    {
        id: "nested",
        label: "Complex nested",
        description: "Quotes inside lists inside quotes.",
        lines: NESTED.split("\n").length,
        content: NESTED,
    },
    {
        id: "huge-1k",
        label: "Stress: ~1,000 lines",
        description: "Generated mid-sized document.",
        lines: 1000,
        content: () => buildHuge(1000),
    },
    {
        id: "huge-5k",
        label: "Stress: ~5,000 lines",
        description: "Generated large document.",
        lines: 5000,
        content: () => buildHuge(5000),
    },
    {
        id: "huge-20k",
        label: "Stress: ~20,000 lines",
        description: "Generated huge document — full AI-streaming stress test.",
        lines: 20000,
        content: () => buildHuge(20000),
    },
];

export function resolveDocContent(doc: SampleDoc): string {
    return typeof doc.content === "function" ? doc.content() : doc.content;
}
