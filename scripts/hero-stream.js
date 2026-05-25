// Hero recording: simulate AI streaming into the editor via window.aiInsertInCursor.
// Paste the IIFE at the bottom into the devtools console of an empty DOMD document.
//
// Mimics real AI token streaming: chunks of 1–5 chars with uniform inter-token jitter.
// No content-aware pauses — like a real model emitting tokens at a roughly constant rate.
//
// Adjust SPEED to globally scale all delays (1.0 = default, 0.7 = faster, 1.3 = slower).
//
const content1 = `# DOMD

A **WYSIWYG** editor for Markdown — *no preview pane*, no flicker.

## What you get

- 20 KB gzipped kernel
- Streaming \`aiInsert()\` — you are watching it now
- Native parse and render in one phase

\`\`\`ts
const md = '# Hello'
render(md)
\`\`\`

> Editing happens directly on Markdown.

[domd.app](https://domd.app)
`;

const content2 = `# DOMD

A **WYSIWYG** editor for Markdown — *no preview pane*, no flicker.

## What you get

- 20 KB gzipped kernel
- Streaming \`aiInsert()\` — you are watching it now
- Native parse and render in one phase

> Editing happens directly on Markdown.

[domd.app](https://domd.app)
`;

const content3 = `# DOMD

A **WYSIWYG** editor — *no preview pane*, no flicker.

## Markdown coverage

| Feature       | Notes                 |
| ------------- | --------------------- |
| Headings      | H1 to H6              |
| Lists & tasks | Nested, checkboxes    |
| Code blocks   | Syntax highlighting   |
| Tables        | You are looking at one |

## Inline

- **Bold**, *italic*, ~~strike~~, \`code\`
- Link: [domd.app](https://domd.app)
- Tasks:
  - [x] Parse
  - [x] Render
  - [ ] Ship

\`\`\`ts
function render(md: string) {
  return parse(md)
}
\`\`\`

> Editing happens on Markdown directly.

---

Made for Markdown.
`;

(async () => {
    const SPEED = 1.0;

    const content = content3;
    if (typeof window.aiInsertInCursor !== "function") {
        console.error("window.aiInsertInCursor is not defined");
        return;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
    const rand = (min, max) => min + Math.random() * (max - min);

    let i = 0;
    while (i < content.length) {
        const chunkSize = 1 + Math.floor(Math.random() * 5); // 1..5
        const chunk = content.slice(i, i + chunkSize);
        window.aiInsertInCursor(chunk);
        i += chunkSize;

        await sleep(rand(25, 60));
    }
})();
