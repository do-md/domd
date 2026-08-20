import { InlineRuleParams } from "../editor/type";

/**
 * `{…}` parameter microsyntax — scanner + parser (v2).
 *
 * Grammar follows the Pandoc/Djot inline-attribute family:
 *
 *     capture     ::= "{" ws? item (ws+ item)* ws? "}"
 *     item        ::= dotword | id | pair | positional
 *     dotword     ::= "." word      (first = variant selector, all land in classes)
 *     id          ::= "#" word      (at most one; later wins)
 *     pair        ::= key "=" value
 *     positional  ::= bare          (no . # = sigil)
 *     value       ::= bare | quoted ("..." with \" and \\ escapes)
 *
 * Both functions are PURE and total: no throwing, no logging. A malformed
 * capture returns null and the caller treats the occurrence as having no
 * capture at all — which for reserved-delimiter rules means the whole rule
 * yields to the builtin syntax (capture presence is the disambiguation
 * signal, see inline-rules.ts).
 *
 * Design doc: project-nexus reference/inline-rules-v2-design.md §3.
 */

const WORD_REG = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEY_REG = WORD_REG;
// Bare tokens/values: no whitespace (tokenizer guarantees), no braces or
// quote chars, no `=` (that shape is a pair).
const BARE_REG = /^[^\s{}"'=]+$/;

export interface ScannedCapture {
    /** Inner text between the braces, verbatim. */
    raw_: string;
    /** Full consumed length INCLUDING both braces. */
    length_: number;
}

/**
 * Scan a `{…}` capture starting exactly at `from` (which must point at `{`).
 * Quote-aware: a `}` inside a double-quoted segment does not terminate, and
 * `\"` / `\\` inside quotes are skipped as escapes. Newlines never occur
 * inside a capture (returns null). Returns null when `from` is not `{` or the
 * capture never closes.
 */
export const scanInlineCapture = (
    text: string,
    from: number,
): ScannedCapture | null => {
    if (text[from] !== "{") return null;
    let i = from + 1;
    let inQuote = false;
    for (const len = text.length; i < len; i += 1) {
        const ch = text[i];
        if (ch === "\n") return null;
        if (inQuote) {
            if (ch === "\\") {
                i += 1; // skip escaped char (covers \" and \\)
                continue;
            }
            if (ch === '"') inQuote = false;
            continue;
        }
        if (ch === '"') {
            inQuote = true;
            continue;
        }
        if (ch === "{") return null; // nested unquoted brace — malformed
        if (ch === "}") {
            return {
                raw_: text.slice(from + 1, i),
                length_: i - from + 1,
            };
        }
    }
    return null;
};

/** Unescape a quoted value body: `\"` → `"`, `\\` → `\`. Other `\x` pairs
 *  keep the backslash verbatim (only the two escapes are defined). */
const unescapeQuoted = (body: string): string => {
    let out = "";
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "\\" && (body[i + 1] === '"' || body[i + 1] === "\\")) {
            out += body[i + 1];
            i += 1;
            continue;
        }
        out += ch;
    }
    return out;
};

/** Split the raw capture body into whitespace-separated tokens, keeping
 *  double-quoted segments (with their escapes) intact inside a token. */
const tokenizeCapture = (raw: string): string[] | null => {
    const tokens: string[] = [];
    let current = "";
    let inQuote = false;
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (inQuote) {
            current += ch;
            if (ch === "\\") {
                if (i + 1 < raw.length) {
                    current += raw[i + 1];
                    i += 1;
                }
                continue;
            }
            if (ch === '"') inQuote = false;
            continue;
        }
        if (ch === '"') {
            inQuote = true;
            current += ch;
            continue;
        }
        if (ch === " " || ch === "\t") {
            if (current) tokens.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (inQuote) return null; // unterminated quote (scanner should prevent)
    if (current) tokens.push(current);
    return tokens;
};

/**
 * Parse a scanned capture body into structured params. Returns null when ANY
 * item violates the grammar — the whole capture is then treated as absent
 * (all-or-nothing keeps the reserved-char disambiguation deterministic).
 * An empty `{}` parses successfully to an empty params object.
 */
export const parseInlineRuleParams = (raw: string): InlineRuleParams | null => {
    const tokens = tokenizeCapture(raw);
    if (tokens === null) return null;

    const params: InlineRuleParams = {
        classes: [],
        named: {},
        positional: [],
    };

    for (const token of tokens) {
        if (token[0] === ".") {
            const word = token.slice(1);
            if (!WORD_REG.test(word)) return null;
            if (params.variant === undefined) params.variant = word;
            params.classes.push(word);
            continue;
        }
        if (token[0] === "#") {
            const word = token.slice(1);
            if (!WORD_REG.test(word)) return null;
            params.id = word; // at most one; later wins (Pandoc-style)
            continue;
        }
        const eq = token.indexOf("=");
        if (eq !== -1) {
            const key = token.slice(0, eq);
            const rawValue = token.slice(eq + 1);
            if (!KEY_REG.test(key)) return null;
            if (!rawValue) return null;
            let value: string;
            if (rawValue[0] === '"') {
                if (rawValue.length < 2 || rawValue.at(-1) !== '"') return null;
                value = unescapeQuoted(rawValue.slice(1, -1));
            } else {
                if (!BARE_REG.test(rawValue)) return null;
                value = rawValue;
            }
            params.named[key] = value;
            continue;
        }
        if (!BARE_REG.test(token)) return null;
        params.positional.push(token);
    }

    return params;
};
