/**
 * Pure text matching with VSCode find-widget semantics. No editor, no DOM —
 * every function here maps strings to ranges, so the whole search engine is
 * unit-testable headless and reusable by any kernel consumer.
 *
 * Coordinate space: absolute character offsets into whatever text the caller
 * scanned — for DoMD that is the kernel's `toMarkdown()` serialization, which
 * makes every match range directly consumable by `setSelection` /
 * `replaceRanges` / `resolveRanges` (the replace family shares this space).
 */

export interface SearchOptions {
    /** Aa — exact case matching. Off: case-insensitive (regex flag `i`). */
    caseSensitive: boolean;
    /** ab| — both match edges must sit on a word boundary (VSCode's
     *  separator-based definition, not `\b`). */
    wholeWord: boolean;
    /** .* — treat the query as an ECMAScript regular expression. */
    regex: boolean;
}

export interface SearchMatch {
    /** Absolute offset, inclusive. */
    start: number;
    /** Absolute offset, exclusive. */
    end: number;
    /**
     * Capture groups of a regex match (`[0]` = whole match) — captured at
     * scan time so replacement expansion sees exactly the groups the scan
     * saw, regardless of later document edits.
     */
    groups?: string[];
}

export type CompiledQuery =
    /** Empty query — matches nothing, distinct from an error. */
    | { kind: "empty" }
    /** Malformed regex — `message` is the engine's parse error. */
    | { kind: "error"; message: string }
    | { kind: "ok"; pattern: RegExp };

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile a query + options into a global regex, VSCode-style: literal
 * queries are escaped; `m` is always on (`^`/`$` address lines, matching the
 * find widget); the `u` flag is attempted first and dropped when the pattern
 * only parses without it (many hand-written patterns use escapes that are
 * errors under `u`).
 */
export const compileQuery = (
    query: string,
    options: SearchOptions,
): CompiledQuery => {
    if (!query) return { kind: "empty" };
    const source = options.regex
        ? query
        : query.replace(REGEX_SPECIALS, "\\$&");
    const flags = `gm${options.caseSensitive ? "" : "i"}`;
    try {
        return { kind: "ok", pattern: new RegExp(source, `${flags}u`) };
    } catch {
        try {
            return { kind: "ok", pattern: new RegExp(source, flags) };
        } catch (error) {
            return {
                kind: "error",
                message:
                    error instanceof Error ? error.message : String(error),
            };
        }
    }
};

/**
 * VSCode's default word separators. A boundary is valid when the adjacent
 * character is missing (text edge), whitespace, or one of these — or when the
 * match's own edge character is itself a separator (so searching `(foo)`
 * whole-word still matches). CJK behaves as in VSCode: ideographs count as
 * word characters.
 */
const WORD_SEPARATORS = new Set("`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?");

const isBoundaryChar = (char: string | undefined): boolean =>
    char === undefined || /\s/.test(char) || WORD_SEPARATORS.has(char);

const isWholeWordMatch = (text: string, start: number, end: number): boolean =>
    (isBoundaryChar(text[start - 1]) || isBoundaryChar(text[start])) &&
    (isBoundaryChar(text[end]) || isBoundaryChar(text[end - 1]));

export interface FindMatchesResult {
    matches: SearchMatch[];
    /** True when the scan stopped at `limit` — the tail of the document was
     *  not searched. Surface this; a silently truncated count reads as
     *  exhaustive. */
    limitHit: boolean;
}

/** VSCode caps its find at 20k matches; same order of magnitude here. */
export const DEFAULT_MATCH_LIMIT = 20000;

/**
 * All non-overlapping matches, left to right. Zero-length regex matches are
 * skipped (an empty "match everywhere" is noise in a find widget), advancing
 * one character so the scan always terminates.
 */
export const findMatches = (
    text: string,
    compiled: CompiledQuery,
    options: SearchOptions,
    limit: number = DEFAULT_MATCH_LIMIT,
): FindMatchesResult => {
    if (compiled.kind !== "ok") return { matches: [], limitHit: false };
    const pattern = compiled.pattern;
    pattern.lastIndex = 0;
    const matches: SearchMatch[] = [];
    for (;;) {
        const found = pattern.exec(text);
        if (!found) break;
        const start = found.index;
        const end = start + found[0].length;
        if (found[0].length === 0) {
            pattern.lastIndex += 1;
            continue;
        }
        if (!options.wholeWord || isWholeWordMatch(text, start, end)) {
            const match: SearchMatch = { start, end };
            if (options.regex && found.length > 1) {
                match.groups = Array.from(found, (g) => g ?? "");
            } else if (options.regex) {
                match.groups = [found[0]];
            }
            matches.push(match);
            if (matches.length >= limit) {
                return { matches, limitHit: pattern.exec(text) !== null };
            }
        }
    }
    return { matches, limitHit: false };
};

/**
 * Expand a replacement template against one match, regex-mode: `$$` → `$`,
 * `$&` / `$0` → whole match, `$1`…`$99` → capture group (empty when the group
 * did not participate), `\n` / `\t` / `\\` → escapes (VSCode supports these
 * in regex replace). Everything else is literal. Non-regex callers should
 * pass the template through untouched instead of calling this.
 */
export const expandReplacement = (
    template: string,
    match: SearchMatch,
): string => {
    const groups = match.groups ?? [];
    let out = "";
    let i = 0;
    while (i < template.length) {
        const char = template[i];
        if (char === "\\" && i + 1 < template.length) {
            const next = template[i + 1];
            if (next === "n") out += "\n";
            else if (next === "t") out += "\t";
            else if (next === "\\") out += "\\";
            else out += char + next;
            i += 2;
            continue;
        }
        if (char === "$" && i + 1 < template.length) {
            const next = template[i + 1];
            if (next === "$") {
                out += "$";
                i += 2;
                continue;
            }
            if (next === "&") {
                out += groups[0] ?? "";
                i += 2;
                continue;
            }
            if (next >= "0" && next <= "9") {
                let num = next;
                if (
                    i + 2 < template.length &&
                    template[i + 2] >= "0" &&
                    template[i + 2] <= "9" &&
                    Number(num + template[i + 2]) < groups.length
                ) {
                    num += template[i + 2];
                }
                const groupIndex = Number(num);
                if (groupIndex < groups.length) {
                    out += groups[groupIndex] ?? "";
                    i += 1 + num.length;
                    continue;
                }
            }
        }
        out += char;
        i += 1;
    }
    return out;
};

/**
 * AB — carry the matched text's casing onto the replacement (VSCode's
 * preserve-case): ALL-UPPER match → upper replacement; all-lower → lower;
 * Title-case (first letter upper) → first letter upper, rest as typed.
 * Matches without cased letters pass the replacement through.
 */
export const preserveCase = (matched: string, replacement: string): string => {
    if (!matched || !replacement) return replacement;
    const hasCased = /[a-zA-Z]/.test(matched);
    if (!hasCased) return replacement;
    if (matched === matched.toUpperCase()) return replacement.toUpperCase();
    if (matched === matched.toLowerCase()) return replacement.toLowerCase();
    const first = matched[0];
    if (first === first.toUpperCase() && first !== first.toLowerCase()) {
        return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
};
