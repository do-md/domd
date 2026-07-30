import type { InlineRule } from "@do-md/core-react";

/**
 * App-wide inline syntax rules for every DOMDProvider mount.
 *
 * Extended inline formatting ported (with credit) from
 * https://github.com/kotaindah55/extended-markdown-syntax, as requested in
 * https://github.com/do-md/domd/issues/13:
 *
 * | Syntax            | Renders as                                          |
 * |-------------------|-----------------------------------------------------|
 * | `^text^`          | <sup>                                               |
 * | `~text~`          | <sub>  (single `~` — `~~text~~` is still del)       |
 * | `=={color}text==` | <mark style="background-color: …"> (inline style)   |
 * | `!!{cls}text!!`   | <span class="custom-span …">                        |
 *
 * `!!` coexists with image syntax: the kernel yields to the builtin whenever
 * `!` is followed by `[`, so `![alt](url)` always parses as an image and
 * `!!x!!` is free for this rule (same faithful delimiters as the original
 * plugin — no deviation needed).
 *
 * NOTE: this array REPLACES the kernel's default rule set. The first entry
 * re-declares `==` with color-tag support, so plain `==text==` still
 * highlights (the `{color}` capture is optional). Collaborative peers must
 * share this exact set (same contract as codeTokenizer), which is why every
 * mount imports this one constant.
 */
export const appInlineRules: InlineRule[] = [
    // `==text==` / `=={red}text==` / `=={#8888ff}text==` — highlight,
    // optionally colored via INLINE STYLE (no pre-provisioned CSS classes).
    // color-mix handles named colors and hex alike and adds translucency so
    // text stays readable on light and dark themes.
    // Supersedes the kernel default `==` rule (same char+length).
    {
        char: "=",
        length: 2,
        capture: {
            to: "style",
            template:
                "background-color: color-mix(in srgb, {} 80%, transparent)",
        },
        tagName: "mark",
        className: "custom-highlight",
    },
    // `^text^` — superscript. Exact single delimiter, no spaces (so casual
    // carets in prose don't trigger it).
    {
        char: "^",
        length: 1,
        exactLen: true,
        allowSpace: false,
        tagName: "sup",
    },
    // `~text~` — subscript. Single `~` only; `~~` stays strikethrough.
    {
        char: "~",
        length: 1,
        exactLen: true,
        allowSpace: false,
        tagName: "sub",
    },
    // `!!{cls}text!!` — custom span carrying arbitrary classes.
    // (`char` is the single delimiter character; `length: 2` makes it `!!`.)
    {
        char: "!",
        length: 2,
        exactLen: true,
        capture: { to: "class" },
        tagName: "span",
        className: "custom-span",
    },
];
