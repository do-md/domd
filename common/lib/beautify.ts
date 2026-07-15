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

/**
 * DOMDProvider `codeBeautify` adapter. Called by core with the whole code
 * block when the user presses Enter inside it; `lang` comes from the fence
 * info string and may be empty. Returns the beautified code, or undefined to
 * skip beautification (unknown/missing language — we never guess). Never
 * throws: a beautifier failure also resolves to undefined.
 */
export function beautify(code: string, lang?: string): string | undefined {
    if (!lang) return undefined;
    const fn = BEAUTIFIERS[lang.toLowerCase()];
    if (!fn) return undefined;
    try {
        return fn(code);
    } catch {
        return undefined;
    }
}
