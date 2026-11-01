// Document generators, copied verbatim from ponjo's test/perf/latency.test.js
// (https://github.com/ponjo-app/ponjo, MIT License, Copyright (c) 2026 Fan Zhang)
// so both editors are measured on byte-identical input.
//
// Docs of an exact length: blocks of every kind, or verses with no blank
// line between them (a Bible: one paragraph), from a seeded list of words.
const BLOCKS = `# Launch plan

We plan to **ship all six features** in week one, then gather
feedback from the [beta cohort](https://example.com/beta) before the public release.

## Risks

* The \`sync\` service may not handle the load.
* Some __old__ notes say _maybe_.

| Item | Owner | Due |
| --- | --- | --- |
| Sync | Ana | Friday |

> A quote, with a [link](https://example.com).

\`\`\`js
const x = 1;
\`\`\`

1. First
2. Second

`;
export const blocks = (chars) => BLOCKS.repeat(Math.ceil(chars / BLOCKS.length)).slice(0, chars);
export function verses(chars) {
  const words = 'and the of he unto they shall God people land son house that his was with for all said'.split(' ');
  let seed = 1;
  let text = '';
  for (let n = 0; text.length < chars; n++) {
    let verse = `Book ${(n / 30 | 0) + 1}:${n % 30 + 1}\t`;
    for (let k = 0; k < 20; k++) verse += `${words[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % words.length]} `;
    text += `${verse.trim()}.\n`;
  }
  return text.slice(0, chars);
}
