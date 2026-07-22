import {
    js as beautifyJs,
    css as beautifyCss,
    html as beautifyHtml,
} from "js-beautify";

type Beautifier = (code: string) => string;

// Conservative settings on purpose: core embeds a cursor-marker line
// (`console.log(<marker>)`) in the code it passes here, and it discards the
// whole result if that line doesn't survive verbatim. Aggressive options that
// rewrite statement contents would silently void every beautify run, so stick
// to indentation/newline handling only.
const OPTIONS = { indent_size: 2, preserve_newlines: true };

const jsMode: Beautifier = (code) => beautifyJs(code, OPTIONS);
const cssMode: Beautifier = (code) => beautifyCss(code, OPTIONS);
const htmlMode: Beautifier = (code) => beautifyHtml(code, OPTIONS);

// Fence language → beautifier. Keys are lowercase; shorthand aliases map to
// the same underlying js-beautify mode. Anything absent is left untouched.
const BEAUTIFIERS: Record<string, Beautifier> = {
    js: jsMode,
    javascript: jsMode,
    jsx: jsMode,
    ts: jsMode,
    typescript: jsMode,
    json: jsMode,
    css: cssMode,
    scss: cssMode,
    less: cssMode,
    html: htmlMode,
    xml: htmlMode,
};

// ---------------------------------------------------------------------------
// Generic fallback: a conservative, language-agnostic re-indenter.
//
// Used for any language without a dedicated beautifier. It only rewrites
// leading whitespace based on bracket nesting ({}, [], ()) and never touches a
// non-whitespace character, so the cursor-marker line always survives verbatim.
//
// Two guard rails keep it safe for indentation-sensitive languages:
//  - If the block contains no real (code-state) `{`, it is returned untouched —
//    Python / YAML / plain text therefore keep the user's own indentation
//    instead of being flattened.
//  - String literals and comments are skipped when counting brackets; multi-
//    line templates and block comments are emitted verbatim (their internal
//    line breaks are data, not layout).
// ---------------------------------------------------------------------------
const INDENT_UNIT = "  ";

type ScanState = { inBlock: boolean; inTemplate: boolean };
type ScanResult = ScanState & { delta: number; sawOpenBrace: boolean };

// Walk one line, carrying multi-line comment / template state across lines.
// Bracket depth changes are counted only while in normal code state.
function scanLine(line: string, carry: ScanState): ScanResult {
    let inBlock = carry.inBlock;
    let inTemplate = carry.inTemplate;
    let inString = false;
    let stringChar = "";
    let inLineComment = false;
    let delta = 0;
    let sawOpenBrace = false;

    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const n = line[i + 1];

        if (inBlock) {
            if (c === "*" && n === "/") {
                inBlock = false;
                i++;
            }
            continue;
        }
        if (inTemplate) {
            if (c === "\\") {
                i++;
                continue;
            }
            if (c === "`") inTemplate = false;
            continue;
        }
        if (inLineComment) continue;
        if (inString) {
            if (c === "\\") {
                i++;
                continue;
            }
            if (c === stringChar) inString = false;
            continue;
        }

        // normal code state
        if (c === "/" && n === "*") {
            inBlock = true;
            i++;
            continue;
        }
        if (c === "/" && n === "/") {
            inLineComment = true;
            i++;
            continue;
        }
        if (c === "#") {
            inLineComment = true;
            continue;
        }
        if (c === "`") {
            inTemplate = true;
            continue;
        }
        if (c === '"' || c === "'") {
            inString = true;
            stringChar = c;
            continue;
        }
        if (c === "{" || c === "[" || c === "(") {
            delta++;
            if (c === "{") sawOpenBrace = true;
            continue;
        }
        if (c === "}" || c === "]" || c === ")") {
            delta--;
            continue;
        }
    }

    return { delta, inBlock, inTemplate, sawOpenBrace };
}

const isCloser = (ch: string): boolean =>
    ch === "}" || ch === "]" || ch === ")";

function reindentByBraces(code: string): string {
    // Fast gate: no brace anywhere means nothing to align.
    if (!code.includes("{")) return code;

    const lines = code.split("\n");
    const out: string[] = [];
    let depth = 0;
    let sawCodeBrace = false;
    let state: ScanState = { inBlock: false, inTemplate: false };

    for (const raw of lines) {
        // Lines inside a multi-line comment / template are content: keep as-is.
        if (state.inBlock || state.inTemplate) {
            out.push(raw);
            const res = scanLine(raw, state);
            state = { inBlock: res.inBlock, inTemplate: res.inTemplate };
            depth = Math.max(0, depth + res.delta);
            sawCodeBrace = sawCodeBrace || res.sawOpenBrace;
            continue;
        }

        const trimmed = raw.trim();
        if (trimmed === "") {
            out.push("");
            continue;
        }

        // Leading closing brackets dedent the line they open on.
        let lead = 0;
        while (lead < trimmed.length && isCloser(trimmed[lead])) lead++;
        const thisDepth = Math.max(0, depth - lead);
        out.push(INDENT_UNIT.repeat(thisDepth) + trimmed);

        const res = scanLine(trimmed, state);
        depth = Math.max(0, depth + res.delta);
        state = { inBlock: res.inBlock, inTemplate: res.inTemplate };
        sawCodeBrace = sawCodeBrace || res.sawOpenBrace;
    }

    // A `{` that only lived inside a string/comment isn't a block: treat the
    // block as indentation-sensitive and keep the original untouched.
    return sawCodeBrace ? out.join("\n") : code;
}

/**
 * DOMDProvider `codeBeautify` adapter. Called by core with the whole code
 * block when the user presses Enter inside it; `lang` comes from the fence
 * info string and may be empty.
 *
 * Routing: js/css/html (and their aliases) get a real js-beautify pass;
 * everything else — unknown or missing language — falls back to the
 * conservative brace re-indenter, which aligns bracketed code and leaves
 * indentation-sensitive code untouched. Never throws: any failure resolves to
 * undefined so core simply skips beautification.
 */
export function beautify(code: string, lang?: string): string | undefined {
    const fn = lang ? BEAUTIFIERS[lang.toLowerCase()] : undefined;
    if (fn) {
        try {
            return fn(code);
        } catch {
            // fall through to the generic re-indenter
        }
    }
    try {
        return reindentByBraces(code);
    } catch {
        return undefined;
    }
}
