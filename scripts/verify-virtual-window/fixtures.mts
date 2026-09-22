/**
 * Shared fixture documents for the virtual-window harness. Each fixture is a
 * self-contained markdown document exercising a distinct block mix, so the
 * off-mode golden comparison covers every default element the root loop
 * renders (paragraphs, headings, code fences, tables, lists, quotes, rules,
 * images, checklists).
 */

export const FIXTURES: Record<string, string> = {
    prose: `# Title

First paragraph with **bold**, *italic*, \`code\` and a [link](https://example.com).

Second paragraph
with a soft break.

## Section

Third paragraph after a heading.
`,
    blocks: `# Mixed blocks

\`\`\`js
const x = 1;
function f(a) { return a + x; }
\`\`\`

| Col A | Col B |
| ----- | ----- |
| a1    | b1    |
| a2    | b2    |

- item one
- item two
  - nested

1. first
2. second

> a quote line
> second quote line

---

![alt text](https://example.com/img.png)

- [ ] todo item
- [x] done item

Tail paragraph.
`,
    long: Array.from({ length: 60 }, (_, i) =>
        i % 7 === 0
            ? `## Heading ${i}`
            : `Paragraph ${i} with some content that varies by index ${i}.`,
    ).join("\n\n"),
};
