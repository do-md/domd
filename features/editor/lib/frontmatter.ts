/**
 * YAML frontmatter handling for the desktop document identity scheme.
 *
 * A file opened (or first saved) by the desktop app gets a `domd-id: <uuid>`
 * key injected into its frontmatter — the authoritative cross-device document
 * identity (see the nexus design doc "obsidian-domd-collab-identity"). Rules:
 *
 *  - The block is only recognized at the ABSOLUTE top of the file (anything
 *    else risks setext-heading corruption in other renderers).
 *  - Merge, never clobber: existing frontmatter keys are preserved verbatim;
 *    we only add the `domd-id` line when it is missing.
 *  - The app layer strips the block before the editor sees the content and
 *    re-prepends it on every save, so the kernel never round-trips `---`
 *    delimiters and the block never enters the shared Y.Doc.
 */

export const DOMD_ID_KEY = "domd-id";

/** Matches a frontmatter block at the absolute top: `---\n...\n---\n?`.
 *  The close delimiter may be the last line of the file (no trailing \n). */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const DOMD_ID_LINE_RE = /^domd-id[ \t]*:[ \t]*(\S+)[ \t]*$/m;

export interface FrontmatterSplit {
    /** Full frontmatter block including delimiters, normalized to end with a
     *  single trailing newline. Null when the file has no frontmatter. */
    prefix: string | null;
    /** Content after the block, leading blank lines removed. */
    body: string;
    /** The `domd-id` value if present inside the block. */
    id: string | null;
}

export const splitFrontmatter = (content: string): FrontmatterSplit => {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return { prefix: null, body: content, id: null };
    const prefix = match[0].replace(/\r?\n$/, "") + "\n";
    const body = content.slice(match[0].length).replace(/^(\r?\n)+/, "");
    const idMatch = match[1].match(DOMD_ID_LINE_RE);
    return { prefix, body, id: idMatch ? idMatch[1] : null };
};

const generateDocId = (): string => crypto.randomUUID();

export interface EnsureIdResult {
    /** Full file content with the id guaranteed present in frontmatter. */
    content: string;
    id: string;
    /** True when `content` differs from the input (id was injected). */
    changed: boolean;
}

/** Guarantee a `domd-id` in the file's frontmatter, injecting one when
 *  missing. Existing frontmatter keys are preserved byte-for-byte. */
export const ensureDomdId = (content: string): EnsureIdResult => {
    const match = content.match(FRONTMATTER_RE);
    if (match) {
        const idMatch = match[1].match(DOMD_ID_LINE_RE);
        if (idMatch) {
            return { content, id: idMatch[1], changed: false };
        }
        const id = generateDocId();
        // Insert as the first line inside the existing block; everything
        // else stays verbatim.
        const openEnd = content.indexOf("\n") + 1;
        const injected =
            content.slice(0, openEnd) +
            `${DOMD_ID_KEY}: ${id}\n` +
            content.slice(openEnd);
        return { content: injected, id, changed: true };
    }
    const id = generateDocId();
    const block = buildFrontmatterBlock(id);
    const body = content.replace(/^(\r?\n)+/, "");
    const joined = body.length > 0 ? `${block}\n${body}` : block;
    return { content: joined, id, changed: true };
};

/** Minimal frontmatter block for a brand-new document. Ends with "\n". */
export const buildFrontmatterBlock = (id: string): string =>
    `---\n${DOMD_ID_KEY}: ${id}\n---\n`;

/** Re-attach a stored frontmatter block to editor-produced markdown. */
export const withFrontmatter = (
    prefix: string | null | undefined,
    md: string,
): string => {
    if (!prefix) return md;
    return md.length > 0 ? `${prefix}\n${md}` : prefix;
};
