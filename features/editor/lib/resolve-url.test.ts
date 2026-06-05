/**
 * Tests for `resolveMarkdownUrl`, focused on the `gh:` shorthand ref parser.
 *
 * Run with: `npx tsc --noEmit features/editor/lib/resolve-url.test.ts`
 * (or any TS-aware runner). The assertions below are deliberately simple
 * string-shape checks so they don't pull in DOM globals.
 */
import { resolveMarkdownUrl } from "./resolve-url";

function case_(input: string, expectRef: string | null, expectPathContains: string) {
    const out = resolveMarkdownUrl(input);
    if (!out) throw new Error(`resolveMarkdownUrl returned null for ${JSON.stringify(input)}`);
    if (expectRef === null) {
        if (out.url.includes("ref=")) {
            throw new Error(`expected no ref in ${out.url} for ${JSON.stringify(input)}`);
        }
    } else {
        if (!out.url.includes(`ref=${expectRef}`)) {
            throw new Error(`expected ref=${expectRef} in ${out.url} for ${JSON.stringify(input)}`);
        }
    }
    if (expectPathContains && !decodeURIComponent(out.url).includes(expectPathContains)) {
        throw new Error(
            `expected ${JSON.stringify(input)} to yield URL containing ${expectPathContains}, got ${out.url}`,
        );
    }
}

export function runResolveUrlTests(): void {
    // Baseline: no `@`, no surprises.
    case_("gh:owner/repo", null, "readme");
    case_("gh:owner/repo:docs/file.md", null, "docs/file.md");
    // Branch ref at the end of a file path: keep working.
    case_("gh:owner/repo:docs/file.md@main", "main", "docs/file.md");
    // Branch ref on the README itself: keep working.
    case_("gh:owner/repo@main", "main", "readme");
    // NEW: filename contains `@` and `.md` — the ref candidate looks like
    // a filename, not a ref. The URL must not include a `ref=` query param,
    // and the path must keep the `file@v1.md` segment.
    const atInFilename = resolveMarkdownUrl("gh:owner/repo:docs/file@v1.md");
    if (!atInFilename) throw new Error("atInFilename: got null");
    if (atInFilename.url.includes("ref=")) {
        throw new Error(`atInFilename: expected no ref, got ${atInFilename.url}`);
    }
    if (!atInFilename.url.includes("docs/file@v1.md")) {
        throw new Error(
            `atInFilename: expected path to include 'docs/file@v1.md', got ${atInFilename.url}`,
        );
    }
}

if (typeof process !== "undefined" && process.env?.RUN_RESOLVE_URL_TESTS === "1") {
    runResolveUrlTests();
    // eslint-disable-next-line no-console
    console.log("resolve-url tests: ok");
}
