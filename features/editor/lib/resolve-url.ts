// ─── URL resolution for Markdown sources ─────────────────────────────────────

export type MarkdownSource = {
    url: string;
    headers?: HeadersInit;
    filename: string;
};

function toHttpsUrlOrNull(input: string): string | null {
    try {
        const u = new URL(input);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        return u.toString();
    } catch {
        return null;
    }
}

/**
 * Convert GitHub "pretty" URLs to raw content URLs.
 * - `github.com/owner/repo/blob/ref/path` → raw.githubusercontent.com
 * - `github.com/owner/repo` (root) → GitHub README API
 */
function resolveGitHubUrl(inputUrl: string): MarkdownSource | null {
    let u: URL;
    try {
        u = new URL(inputUrl);
    } catch {
        return null;
    }

    if (u.hostname === "github.com") {
        const parts = u.pathname.split("/").filter(Boolean);
        const owner = parts[0];
        const repo = parts[1];
        if (!owner || !repo) return null;

        // blob URL → raw.githubusercontent.com
        if (parts[2] === "blob" && parts.length >= 5) {
            const ref = parts[3];
            const filePath = parts.slice(4).join("/");
            const filename = filePath.split("/").pop() ?? "README.md";
            return {
                url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
                filename,
            };
        }

        // repo homepage → GitHub README API
        const refFromTree =
            parts[2] === "tree" && parts[3] ? parts[3] : null;
        const api = new URL(
            `https://api.github.com/repos/${owner}/${repo}/readme`,
        );
        if (refFromTree) api.searchParams.set("ref", refFromTree);
        return {
            url: api.toString(),
            headers: { Accept: "application/vnd.github.raw" },
            filename: `${repo}-README.md`,
        };
    }

    // Already a raw URL
    if (u.hostname === "raw.githubusercontent.com") {
        const filename = u.pathname.split("/").pop() ?? "README.md";
        return { url: u.toString(), filename };
    }

    return null;
}

/**
 * Handle `gh:owner/repo[:path][@ref]` shorthand.
 */
function resolveGitHubSpec(spec: string): MarkdownSource | null {
    if (!spec.startsWith("gh:")) return null;
    const rest = spec.slice(3).trim();
    if (!rest) return null;

    const at = rest.lastIndexOf("@");
    const beforeAt = at >= 0 ? rest.slice(0, at) : rest;
    const ref = at >= 0 ? rest.slice(at + 1).trim() : null;

    const [repoPart, filePartRaw] = beforeAt.split(":", 2);
    const m = repoPart.match(/^([^/]+)\/([^/]+)$/);
    if (!m) return null;
    const [, owner, repo] = m;

    const headers = {
        Accept: "application/vnd.github.raw",
    } as const;

    // README
    if (!filePartRaw) {
        const api = new URL(
            `https://api.github.com/repos/${owner}/${repo}/readme`,
        );
        if (ref) api.searchParams.set("ref", ref);
        return { url: api.toString(), headers, filename: `${repo}-README.md` };
    }

    // Specific file
    const filePath = filePartRaw.replace(/^\/+/, "");
    const api = new URL(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    );
    if (ref) api.searchParams.set("ref", ref);
    const filename = filePath.split("/").pop() ?? "file.md";
    return { url: api.toString(), headers, filename };
}

/**
 * Resolve a user input string to a fetchable Markdown source.
 * Returns null if the input is not a valid URL / shorthand.
 */
export function resolveMarkdownUrl(input: string): MarkdownSource | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // gh: shorthand
    const ghSpec = resolveGitHubSpec(trimmed);
    if (ghSpec) return ghSpec;

    // GitHub pretty URL
    const ghUrl = resolveGitHubUrl(trimmed);
    if (ghUrl) return ghUrl;

    // Generic http(s) URL
    const normalized = toHttpsUrlOrNull(trimmed);
    if (normalized) {
        const filename =
            new URL(normalized).pathname.split("/").pop() || "document.md";
        return { url: normalized, filename };
    }

    return null;
}

/**
 * Fetch markdown content from a resolved URL.
 */
export async function fetchMarkdown(
    url: string,
    headers?: HeadersInit,
    signal?: AbortSignal,
): Promise<string> {
    const res = await fetch(url, { signal, headers });
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
    }
    return res.text();
}
