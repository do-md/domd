import type { FilePathInfo, FilePathKind } from "../editor/type";

const LOCATION_SUFFIX_REG =
    /(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/;

const FILE_EXTENSION_REG =
    /\.[A-Za-z0-9][A-Za-z0-9+_-]{0,15}$/;

const COMMON_POSIX_ROOTS = new Set([
    "Applications",
    "Library",
    "System",
    "Users",
    "Volumes",
    "dev",
    "etc",
    "home",
    "media",
    "mnt",
    "opt",
    "private",
    "srv",
    "tmp",
    "usr",
    "var",
]);

// Characters peeled off the end of an unquoted candidate: the same sentence
// punctuation and quotes the bare URL autolink trims (parseInline.ts), plus
// full-width and typographic forms; closing brackets go through
// PAIRED_PATH_PUNCTUATION.
const TRAILING_PATH_PUNCTUATION = new Set([
    ".",
    ",",
    "!",
    "?",
    ":",
    ";",
    "'",
    '"',
    "’",
    "，",
    "。",
    "！",
    "？",
    "；",
    "、",
    "）",
    "】",
    "》",
    "」",
    "』",
    "〕",
    "〉",
    "›",
]);

const PAIRED_PATH_PUNCTUATION: Record<string, string> = {
    ")": "(",
    "]": "[",
    "}": "{",
    "）": "（",
    "】": "【",
    "》": "《",
    "」": "「",
    "』": "『",
    "〕": "〖",
    "〉": "〈",
    "›": "‹",
};

// Opening → closing quote that can delimit a quoted candidate.
const QUOTE_PAIRS: Record<string, string> = {
    '"': '"',
    "'": "'",
    "“": "”",
    "‘": "’",
};

// Quote characters that also serve as an apostrophe inside a word.
const APOSTROPHES = new Set(["'", "’"]);

// Outside quotes, sentence punctuation and quote characters are lexical
// boundaries rather than path data. This keeps adjacent prose out of the
// candidate, while an explicitly quoted path can still contain the same
// punctuation. Apostrophes stay legal inside a name (`Bob's.txt`) and are only
// trimmed from the end.
const UNQUOTED_BOUNDARIES = new Set([
    ",",
    "!",
    "?",
    ";",
    '"',
    "“",
    "”",
    "‘",
    "：",
    "，",
    "。",
    "！",
    "？",
    "；",
    "、",
]);

const isWordChar = (char: string): boolean =>
    !!char && /[\p{L}\p{N}_@]/u.test(char);

const isWhitespace = (char: string): boolean => /\s/.test(char);

// Ends every candidate, quoted or not: line breaks, plus the inline-markup
// and table delimiters whose meaning belongs to the Markdown grammar.
const isHardBoundary = (char: string): boolean =>
    char === "\n" ||
    char === "\r" ||
    char === "\t" ||
    char === "<" ||
    char === ">" ||
    char === "`" ||
    char === "|" ||
    char === "*";

const isEscaped = (source: string, index: number): boolean => {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) {
        slashes += 1;
    }
    return slashes % 2 === 1;
};

const countChar = (text: string, target: string): number => {
    let count = 0;
    for (const char of text) {
        if (char === target) count += 1;
    }
    return count;
};

const trimTrailingPunctuation = (raw: string): string => {
    let end = raw.length;
    while (end > 0) {
        const char = raw[end - 1];
        const open = PAIRED_PATH_PUNCTUATION[char];
        if (open) {
            const prefix = raw.slice(0, end - 1);
            if (countChar(prefix, char) >= countChar(prefix, open)) {
                end -= 1;
                continue;
            }
            break;
        }
        if (!TRAILING_PATH_PUNCTUATION.has(char)) break;
        end -= 1;
    }
    return raw.slice(0, end);
};

const classifyPath = (path: string): FilePathKind | null => {
    if (/^file:\/\/(?:localhost)?\//i.test(path)) return "file-uri";
    if (path.startsWith("~/")) return "home";
    if (path.startsWith("./") || path.startsWith("../")) return "relative";
    if (path.startsWith("/") && !path.startsWith("//")) return "absolute";
    if (
        path.includes("/") &&
        !path.startsWith("/") &&
        !path.includes("://")
    ) {
        return "relative";
    }
    return null;
};

const splitLocation = (
    raw: string,
): Pick<FilePathInfo, "path" | "line" | "column"> => {
    const match = raw.match(LOCATION_SUFFIX_REG);
    if (!match) return { path: raw };
    const line = Number(match[1] ?? match[3]);
    const columnText = match[2] ?? match[4];
    return {
        path: raw.slice(0, -match[0].length),
        line,
        ...(columnText ? { column: Number(columnText) } : {}),
    };
};

const hasFileExtension = (path: string): boolean => {
    const slash = path.lastIndexOf("/");
    return FILE_EXTENSION_REG.test(path.slice(slash + 1));
};

const hasCommonAbsoluteRoot = (path: string): boolean => {
    if (!path.startsWith("/")) return false;
    const first = path.slice(1).split("/", 1)[0];
    return COMMON_POSIX_ROOTS.has(first);
};

/** Plausibility of an already-delimited candidate. Identical for quoted and
 *  unquoted text: quotes only decide where a candidate ends, never whether an
 *  ambiguous string counts as a path. */
const isValidCandidate = (raw: string): FilePathInfo | null => {
    const location = splitLocation(raw);
    const kind = classifyPath(location.path);
    if (!kind || location.path.endsWith(":")) return null;

    if (kind === "file-uri") {
        if (!/^file:\/\/(?:localhost)?\/[^\s]+/i.test(location.path)) {
            return null;
        }
    } else if (kind === "relative") {
        const explicit =
            location.path.startsWith("./") || location.path.startsWith("../");
        if (!explicit && !hasFileExtension(location.path)) {
            return null;
        }
    } else if (
        kind === "absolute" &&
        !hasFileExtension(location.path) &&
        !hasCommonAbsoluteRoot(location.path)
    ) {
        return null;
    }

    return { raw, kind, ...location };
};

/**
 * Unquoted extent: one whitespace-free token that also stops at sentence
 * punctuation and quotes. Like GFM extended autolinks, a candidate never spans
 * whitespace — without IO a space inside a path cannot be told apart from the
 * prose around it (`/tmp/build then open index.html`).
 */
const scanUnquotedToken = (source: string, start: number): string => {
    let end = start;
    while (end < source.length) {
        const char = source[end];
        if (
            isHardBoundary(char) ||
            isWhitespace(char) ||
            UNQUOTED_BOUNDARIES.has(char)
        ) {
            break;
        }
        end += 1;
    }
    return source.slice(start, end);
};

/**
 * Quoted extent: the content between the opening quote just before `start`
 * and its closing quote on the same line, where whitespace and sentence
 * punctuation are path data. The content must not end in whitespace, and a
 * quote character glued to a word on its outer side is an apostrophe (`it's`),
 * not a quote. Other quotes have no such second role, so they may touch
 * adjacent text, as they do in scripts written without spaces. An unclosed
 * quote opens nothing.
 */
const scanQuotedContent = (
    source: string,
    start: number,
    open: string,
): string | null => {
    const close = QUOTE_PAIRS[open];
    const isApostrophe = (quote: string, outer: string) =>
        APOSTROPHES.has(quote) && isWordChar(outer);
    if (isApostrophe(open, source[start - 2] ?? "")) return null;
    let end = start;
    while (end < source.length && source[end] !== close) {
        if (isHardBoundary(source[end])) return null;
        end += 1;
    }
    if (end >= source.length || end === start) return null;
    if (isWhitespace(source[end - 1])) return null;
    if (isApostrophe(close, source[end + 1] ?? "")) return null;
    return source.slice(start, end);
};

const matchDelimited = (
    raw: string,
    startsExplicitly: boolean,
    quoted: boolean,
): FilePathInfo | null => {
    if (!raw) return null;
    if (!startsExplicitly) {
        const firstSlash = raw.indexOf("/");
        if (firstSlash <= 0) return null;
        // Unquoted, a colon in the first segment is prose glued to the path
        // (`Note:docs/a.md`), not a directory name.
        if (!quoted && raw.slice(0, firstSlash).includes(":")) return null;
    }
    return isValidCandidate(raw);
};

/**
 * Match one local-file candidate at an exact source offset. This is purely
 * lexical: it never expands `~`, resolves a cwd, decodes a URI, or probes IO.
 * Ambiguous unprefixed relative paths require a file extension; ambiguous
 * extensionless absolute paths require a common POSIX root. A quoted reading
 * is tried first and may span whitespace; when it is not a path the ordinary
 * unquoted reading applies.
 */
export const matchFilePathAt = (
    source: string,
    start: number,
): FilePathInfo | null => {
    if (start < 0 || start >= source.length || isEscaped(source, start)) {
        return null;
    }

    const prev = start > 0 ? source[start - 1] : "";
    if (isWordChar(prev) || /[./~:-]/.test(prev)) return null;
    const prefix = source.slice(start, start + 18).toLowerCase();

    const startsExplicitly =
        source[start] === "/" ||
        source.startsWith("~/", start) ||
        source.startsWith("./", start) ||
        source.startsWith("../", start) ||
        prefix.startsWith("file:///") ||
        prefix.startsWith("file://localhost/");

    if (!startsExplicitly && !isWordChar(source[start])) return null;

    if (QUOTE_PAIRS[prev]) {
        const content = scanQuotedContent(source, start, prev);
        const quoted =
            content !== null && matchDelimited(content, startsExplicitly, true);
        if (quoted) return quoted;
    }

    return matchDelimited(
        trimTrailingPunctuation(scanUnquotedToken(source, start)),
        startsExplicitly,
        false,
    );
};
