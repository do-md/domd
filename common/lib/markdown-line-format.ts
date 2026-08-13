/**
 * Pure markdown line-prefix algebra for the "Aa" format menu.
 *
 * Every paragraph/list/quote style the menu offers is, in markdown source, a
 * LINE PREFIX. Parsing a line into `indent + quote + list + heading + content`
 * and rebuilding it turns "make this a heading" into a surgical rewrite of the
 * prefix region only — content characters (and therefore the kernel's span
 * identities, collaborative ops and undo granularity) are never touched.
 *
 * Prefix order is markdown's, not the menu's: `  > > - [ ] ### text`. Heading
 * and list are ORTHOGONAL, exactly like Apple Notes treats them — the kernel
 * round-trips `- # item` as a heading nested in a list item, so applying a
 * list style never destroys a paragraph style and vice versa.
 *
 * No store, no DOM: everything here is string in / string out.
 */

/** The three list flavours the menu can apply. */
export type ListKind = "bullet" | "ordered" | "todo";

/** Paragraph style = heading level, where 0 is body text. The menu exposes
 *  1-3 (标题/小标题/副标题) plus 0 (正文); deeper levels are preserved when
 *  they already exist in the document, they just have no menu entry. */
export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface LinePrefix {
    /** Leading whitespace, kept verbatim. */
    indent: string;
    /** Blockquote markers, e.g. `"> "` or `"> > "`. Empty when not quoted. */
    quote: string;
    /** Nesting depth of `quote` (number of `>` markers). */
    quoteDepth: number;
    /** Which list flavour the line carries, null when it is not a list item. */
    listKind: ListKind | null;
    /** `true` for a `- [x]` item, `false` for `- [ ]`. Only set for "todo". */
    checked: boolean;
    /** 0 = body text, 1-6 = `#`..`######`. */
    heading: HeadingLevel;
    /** Everything after the prefix. */
    content: string;
}

const QUOTE_RE = /^(?:>[ \t]?)+/;
const BULLET_RE = /^([-*+])[ \t]+/;
const ORDERED_RE = /^(\d{1,9})([.)])[ \t]+/;
const TASK_RE = /^\[([ xX])\][ \t]+/;
const HEADING_RE = /^(#{1,6})[ \t]+/;

/** Split one markdown source line into its prefix parts. Never throws; a line
 *  with no markers parses as pure content. */
export function parseLine(line: string): LinePrefix {
    let rest = line;

    const indent = /^[ \t]*/.exec(rest)![0];
    rest = rest.slice(indent.length);

    const quoteMatch = QUOTE_RE.exec(rest);
    const quote = quoteMatch ? quoteMatch[0] : "";
    const quoteDepth = quote ? (quote.match(/>/g) ?? []).length : 0;
    rest = rest.slice(quote.length);

    let listKind: ListKind | null = null;
    let checked = false;
    const bullet = BULLET_RE.exec(rest);
    const ordered = bullet ? null : ORDERED_RE.exec(rest);
    if (bullet || ordered) {
        rest = rest.slice((bullet ?? ordered)![0].length);
        // A task marker only counts on top of a list marker — bare `[ ] x` is
        // literal text in every markdown flavour, GFM included.
        const task = TASK_RE.exec(rest);
        if (task) {
            listKind = "todo";
            checked = task[1] !== " ";
            rest = rest.slice(task[0].length);
        } else {
            listKind = bullet ? "bullet" : "ordered";
        }
    }

    const headingMatch = HEADING_RE.exec(rest);
    const heading = (headingMatch ? headingMatch[1].length : 0) as HeadingLevel;
    rest = rest.slice(headingMatch ? headingMatch[0].length : 0);

    return { indent, quote, quoteDepth, listKind, checked, heading, content: rest };
}

/** Canonical marker text for each list flavour. Ordered items always emit
 *  `1.` — the kernel renumbers on serialization (`1. a / 1. b` round-trips as
 *  `1. a / 2. b`), so callers never have to track sibling numbering. */
function listMarker(kind: ListKind, checked: boolean): string {
    if (kind === "bullet") return "- ";
    if (kind === "ordered") return "1. ";
    return checked ? "- [x] " : "- [ ] ";
}

/** Render just the prefix of a parsed line (everything before `content`). */
export function buildPrefix(p: LinePrefix): string {
    const quote = "> ".repeat(p.quoteDepth);
    const list = p.listKind ? listMarker(p.listKind, p.checked) : "";
    const heading = p.heading ? "#".repeat(p.heading) + " " : "";
    return p.indent + quote + list + heading;
}

/** Length of the prefix as it appears in the ORIGINAL line — needed to build
 *  a replace range that covers exactly the old prefix. */
export function prefixLength(line: string, parsed: LinePrefix): number {
    return line.length - parsed.content.length;
}

/** Paired inline-mark delimiters, stripped by "clear formatting". Order
 *  matters: the two-character runs must go before their one-character
 *  prefixes, or `**bold**` degrades to `*bold*`. Links are deliberately absent
 *  — a link is content, not formatting, and the menu has its own entry. */
const INLINE_MARK_PATTERNS: Array<[RegExp, string]> = [
    [/\*\*([^*]+)\*\*/g, "$1"],
    [/__([^_]+)__/g, "$1"],
    [/~~([^~]+)~~/g, "$1"],
    [/==([^=]+)==/g, "$1"],
    [/<u>([\s\S]*?)<\/u>/g, "$1"],
    [/\*([^*]+)\*/g, "$1"],
    [/_([^_]+)_/g, "$1"],
    [/`([^`]+)`/g, "$1"],
];

/** Remove inline mark delimiters (bold/italic/underline/strike/highlight/code)
 *  from a markdown fragment, leaving the text they wrapped. Nested marks fall
 *  out of the ordering above in a single pass: `**==x==**` → `==x==` → `x`. */
export function stripInlineMarks(text: string): string {
    let out = text;
    for (const [re, replacement] of INLINE_MARK_PATTERNS) {
        out = out.replace(re, replacement);
    }
    return out;
}

export interface LineRange {
    /** Absolute offset of the line's first character in the document. */
    start: number;
    /** Absolute offset one past the line's last character (excludes `\n`). */
    end: number;
    text: string;
}

/**
 * Every source line the range [selStart, selEnd] touches. A collapsed caret
 * yields exactly the line it sits on. A selection that ends exactly at a line
 * start does NOT drag that line in — selecting to the end of line 1 should
 * format line 1, not lines 1 and 2.
 */
export function linesInRange(
    md: string,
    selStart: number,
    selEnd: number,
): LineRange[] {
    const out: LineRange[] = [];
    let lineStart = 0;
    while (lineStart <= md.length) {
        const nl = md.indexOf("\n", lineStart);
        const lineEnd = nl === -1 ? md.length : nl;
        const touches =
            lineStart <= selEnd &&
            lineEnd >= selStart &&
            // Zero-width overlap at a boundary only counts for a collapsed caret.
            !(selEnd === lineStart && selEnd > selStart);
        if (touches) {
            out.push({ start: lineStart, end: lineEnd, text: md.slice(lineStart, lineEnd) });
        }
        if (nl === -1 || lineStart > selEnd) break;
        lineStart = nl + 1;
    }
    return out;
}

/**
 * Fenced-code state at every line of the document: `true` while the line is
 * part of a ``` block (fences included). Used to let the code-block toggle
 * find the fences it must remove.
 */
export function fenceMap(md: string): boolean[] {
    const lines = md.split("\n");
    const out: boolean[] = [];
    let open = false;
    for (const line of lines) {
        const isFence = /^[ \t]*(```|~~~)/.test(line);
        if (isFence) {
            out.push(true);
            open = !open;
        } else {
            out.push(open);
        }
    }
    return out;
}

/** Why a line refuses prefix styling. */
export type LineGuard = "code" | "table" | "rule";

const TABLE_ROW_RE = /^[ \t]{0,3}\|/;
const THEMATIC_BREAK_RE = /^[ \t]{0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/;

/**
 * Lines whose leading characters are STRUCTURE, not a paragraph marker, so a
 * prefix rewrite would corrupt them rather than style them. Prefixing a table
 * row turns `| a | b |` into `# | a | b |` and the table is gone; the same
 * goes for a `---` rule and for anything inside a code fence, where a `#` is
 * code rather than a heading. `null` means the line is freely styleable.
 */
export function lineGuards(md: string): Array<LineGuard | null> {
    const fenced = fenceMap(md);
    return md.split("\n").map((line, i) => {
        if (fenced[i]) return "code";
        if (TABLE_ROW_RE.test(line)) return "table";
        if (THEMATIC_BREAK_RE.test(line)) return "rule";
        return null;
    });
}

/** 0-based index of the line containing `pos`. */
export function lineIndexAt(md: string, pos: number): number {
    let index = 0;
    for (let i = 0; i < pos && i < md.length; i++) {
        if (md[i] === "\n") index++;
    }
    return index;
}
