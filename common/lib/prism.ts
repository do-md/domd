import Prism, { type Token } from "prismjs";

export type CodeToken = string | Token;

// Eager: high-frequency languages people actually write in markdown.
// Everything else is lazy-loaded on demand via ensureGrammar().
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-php";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";

// Common shorthands users write in fenced code blocks.
const ALIAS: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    py: "python",
    rs: "rust",
    md: "markdown",
    yml: "yaml",
    cs: "csharp",
    "c#": "csharp",
    "c++": "cpp",
    kt: "kotlin",
};

const inflight = new Map<string, Promise<boolean>>();
const known404 = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function normalize(lang: string): string {
    const k = lang.toLowerCase();
    return ALIAS[k] ?? k;
}

function notify() {
    version += 1;
    for (const cb of listeners) cb();
}

/**
 * Lazy-load a Prism grammar. Resolves true when the grammar is registered on
 * `Prism.languages`, false if the package doesn't exist or fails to load.
 * Identical concurrent calls share one inflight Promise.
 */
export function ensureGrammar(lang: string): Promise<boolean> {
    if (!lang) return Promise.resolve(false);
    const norm = normalize(lang);
    if (Prism.languages[norm]) return Promise.resolve(true);
    if (known404.has(norm)) return Promise.resolve(false);
    const existing = inflight.get(norm);
    if (existing) return existing;

    const load = import(
        /* webpackChunkName: "prism-lang-[request]" */
        `prismjs/components/prism-${norm}`
    )
        .then(() => {
            inflight.delete(norm);
            const ok = !!Prism.languages[norm];
            if (ok) notify();
            else known404.add(norm);
            return ok;
        })
        .catch(() => {
            inflight.delete(norm);
            known404.add(norm);
            return false;
        });

    inflight.set(norm, load);
    return load;
}

export function subscribeGrammarLoad(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function getGrammarVersion(): number {
    return version;
}

/**
 * Synchronous tokenize. If the grammar is loaded, tokenize now; otherwise
 * kick off an async load (callers can subscribe via subscribeGrammarLoad to
 * re-tokenize once it lands) and return an empty array so the code block
 * renders as plain text in the meantime.
 */
export function tokenize(code: string, lang?: string): CodeToken[] {
    if (!lang) return [];
    const norm = normalize(lang);
    const grammar = Prism.languages[norm];
    if (grammar) return Prism.tokenize(code, grammar);
    void ensureGrammar(norm);
    return [];
}

export default Prism;
