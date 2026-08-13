/**
 * BYOK LLM client for the agent edit protocol: a single NON-STREAMING
 * request using Aider-style SEARCH/REPLACE blocks — the industry-standard
 * agent editing format (git conflict markers are native to model training
 * data, which is why it benchmarks far above invented schemes). Prompt
 * wording and the fetch-whole-then-apply discipline follow aider verbatim;
 * failed blocks reflect back for one corrective retry.
 */
import i18n from "@/common/i18n";
import type { AiProvider } from "./types";

const ENDPOINTS: Record<AiProvider, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export class AgentStreamError extends Error {}

export interface LlmMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export const CURSOR_MARKER = "<<CURSOR>>";

/** The single edit request: SEARCH/REPLACE blocks for modifications, raw
 *  content for pure generation at the invocation caret. */
export const buildAgentMessages = (options: {
    agentName: string;
    agentPrompt: string;
    /** Document markdown with CURSOR_MARKER injected at the invocation
     *  point. */
    documentWithCursor: string;
    instruction: string;
}): LlmMessage[] => {
    // The block-format section below follows aider's editblock system
    // prompt (numbered structure + verbatim rule sentences) — the format
    // description models are demonstrably best at following.
    const system = [
        `You are "${options.agentName}", an AI collaborator inside a live Markdown editor.`,
        `The document below contains the marker ${CURSOR_MARKER} at the position where the user invoked you. The marker is NOT part of the document — never include it in a SEARCH section and never output it.`,
        ``,
        `Reply in EXACTLY ONE of these two modes:`,
        ``,
        `MODE A — modify existing text, using *SEARCH/REPLACE blocks*.`,
        ``,
        `# *SEARCH/REPLACE block* Rules:`,
        ``,
        `Every *SEARCH/REPLACE block* must use this format:`,
        `1. The start of search block: <<<<<<< SEARCH`,
        `2. A contiguous chunk of lines to search for in the existing document`,
        `3. The dividing line: =======`,
        `4. The lines to replace into the document`,
        `5. The end of the replace block: >>>>>>> REPLACE`,
        ``,
        `Use the *FULL* markers exactly as shown: <<<<<<< SEARCH, =======, >>>>>>> REPLACE — every block needs ALL THREE marker lines.`,
        ``,
        `Every *SEARCH* section must *EXACTLY MATCH* the existing document content, character for character, including all whitespace and blank lines.`,
        ``,
        `*SEARCH/REPLACE* blocks will *only* replace the first match occurrence. Include multiple unique *SEARCH/REPLACE* blocks if needed. Include enough lines in each SEARCH section to uniquely match each set of lines that need to change.`,
        ``,
        `Keep *SEARCH/REPLACE* blocks concise. Break large changes into a series of smaller blocks that each change a small portion. Include just the changing lines, and a few surrounding lines if needed for uniqueness. Do not include long runs of unchanging lines.`,
        ``,
        `To move text within the document, use 2 *SEARCH/REPLACE* blocks: 1 to delete it from its current location, 1 to insert it in the new location.`,
        ``,
        `To delete text, use an empty REPLACE section.`,
        ``,
        `MODE B — write new content at the cursor. When the instruction asks for brand-new content (nothing existing changes), output ONLY the raw Markdown to insert at ${CURSOR_MARKER}. No explanations, no code fences around the reply, no block markers.`,
        ``,
        `MODE SELECTION (critical):`,
        `- If the instruction transforms text that already exists — rewrite, translate, fix, correct, improve, shorten, expand, reformat, rename, delete — you MUST use MODE A. This holds even when the change touches the entire document.`,
        `- Use MODE B ONLY for brand-new content that replaces nothing.`,
        `- When in doubt, prefer MODE A.`,
        ``,
        `Never mix modes. Never output anything except the blocks (Mode A) or the inserted content (Mode B).`,
    ].join("\n");

    const persona = options.agentPrompt.trim();
    const user = [
        ...(persona ? [persona, ""] : []),
        `## Document`,
        `<<<DOCUMENT>>>`,
        options.documentWithCursor,
        `<<<END DOCUMENT>>>`,
        ``,
        `## Instruction`,
        ``,
        options.instruction,
    ].join("\n");

    return [
        { role: "system", content: system },
        { role: "user", content: user },
    ];
};

/** Aider-style reflection message for failed blocks — sent back to the
 *  model (with its own reply as assistant context) for ONE corrective
 *  retry. Wording mirrors aider's apply_edits error report. */
export const buildReflectionMessage = (
    failures: { reason: string; search?: string }[],
    appliedCount: number,
): string => {
    const failedBlocks = failures.filter((f) => f.reason === "not_found");
    const malformed = failures.filter((f) => f.reason === "malformed");
    const parts: string[] = [];
    const total = failedBlocks.length + malformed.length;
    parts.push(
        `# ${total} SEARCH/REPLACE block(s) failed to ${malformed.length > 0 ? "parse or match" : "match"}!`,
    );
    for (const f of failedBlocks) {
        parts.push(
            ``,
            `## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in the document:`,
            `<<<<<<< SEARCH`,
            f.search ?? "",
            `=======`,
        );
    }
    if (malformed.length > 0) {
        parts.push(
            ``,
            `## Malformed block(s): ${malformed.map((f) => f.search ?? "structure error").join("; ")}.`,
            `Every block needs ALL THREE marker lines: <<<<<<< SEARCH, =======, >>>>>>> REPLACE.`,
        );
    }
    parts.push(
        ``,
        `The SEARCH section must exactly match an existing block of lines including all white space, blank lines and punctuation.`,
    );
    if (appliedCount > 0) {
        parts.push(
            ``,
            `# The other ${appliedCount} SEARCH/REPLACE block(s) were applied successfully. Don't re-send them. Just reply with fixed versions of the block(s) above that failed.`,
        );
    }
    return parts.join("\n");
};

// ---------------------------------------------------------------------------
// Transport.
// ---------------------------------------------------------------------------

/** Non-streaming completion against an OpenAI-compatible endpoint (aider
 *  semantics: fetch the whole reply, then parse and apply — stability over
 *  streaming). Runs entirely in the browser — the key never touches a DOMD
 *  server. */
export async function completeAgentChat(
    apiKey: string,
    provider: AiProvider,
    model: string,
    messages: LlmMessage[],
): Promise<string> {
    let res: Response;
    try {
        res = await fetch(ENDPOINTS[provider], {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, stream: false, messages }),
        });
    } catch {
        throw new AgentStreamError(i18n.t("ai.errors.network"));
    }
    if (res.status === 401 || res.status === 403) {
        throw new AgentStreamError(i18n.t("ai.errors.auth"));
    }
    if (!res.ok) {
        throw new AgentStreamError(i18n.t("ai.errors.generic"));
    }
    let content: unknown;
    try {
        const json = await res.json();
        content = json?.choices?.[0]?.message?.content;
    } catch {
        throw new AgentStreamError(i18n.t("ai.errors.generic"));
    }
    if (typeof content !== "string") {
        throw new AgentStreamError(i18n.t("ai.errors.generic"));
    }
    return content;
}

// ---------------------------------------------------------------------------
// Offline mock (model === "mock"): full pipeline with no API key.
// `s/old/new/` -> one SEARCH/REPLACE block (empty new = deletion);
// anything else -> content mode with a greeting.
// ---------------------------------------------------------------------------

const mockSleep = (ms: number) =>
    typeof document !== "undefined" && document.visibilityState === "hidden"
        ? Promise.resolve()
        : new Promise((r) => setTimeout(r, ms));

const parseSubstitution = (
    instruction: string,
): { search: string; replace: string } | null => {
    const match = /^s\/((?:[^/\\]|\\.)+)\/((?:[^/\\]|\\.)*)\//.exec(
        instruction.trim(),
    );
    if (!match) return null;
    const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
    return { search: unescape(match[1]), replace: unescape(match[2]) };
};

export async function mockAgentComplete(
    agentName: string,
    instruction: string,
): Promise<string> {
    await mockSleep(500); // approximate request latency
    const sub = parseSubstitution(instruction);
    return sub
        ? [
              "<<<<<<< SEARCH",
              sub.search,
              "=======",
              ...(sub.replace === "" ? [] : [sub.replace]),
              ">>>>>>> REPLACE",
              "",
          ].join("\n")
        : `Hello! I am **${agentName}** (mock). You said: ${instruction}`;
}
