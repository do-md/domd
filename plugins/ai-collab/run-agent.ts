/**
 * One AI agent invocation, driven by the industry-proven Aider-style
 * SEARCH/REPLACE block protocol — NON-STREAMING, exactly like aider: the
 * complete reply is fetched, parsed as a whole, then applied block by
 * block. Stability over streaming theatrics (user decision 2026-08-07).
 *
 * Per-block application keeps the collaborator feel without streaming:
 *
 *   1. resolve the block's SEARCH against the CURRENT document;
 *   2. SELECT the matched region (kernel setSelection — no ops, no undo
 *      step; broadcast via presence, every peer sees the intent);
 *   3. hold the selection briefly so the intent is visible;
 *   4. apply the block atomically via replaceRanges (ONE edit, single undo
 *      step, fine-grained ops, span identity preserved) — an empty REPLACE
 *      on a complete block deletes the region (aider semantics);
 *   5. move to the next block.
 *
 * Matching follows Aider's leniency ladder: exact match, then line-level
 * whitespace-tolerant matching. Safety rules:
 *   - an unmatched SEARCH is SKIPPED and reported — never force-applied;
 *   - an incomplete/malformed block is NEVER applied (zero side effects);
 *   - replies with no blocks are CONTENT mode: inserted at the invocation
 *     caret in one edit.
 *
 * The agent is a regular collaborator on the session's shared Y.Doc:
 * identity in the collaborator registry, spans in the authorship map,
 * bursts in the version timeline, caret/selection as a virtual peer.
 */
import type * as Y from "yjs";
import type {
    CursorPosition,
    CursorSnapshot,
    RenderDataOp,
} from "../collaboration/crdt-sync/types";
import type {
    RealtimeSyncHandle,
    VirtualPeerHandle,
} from "../collaboration/realtime-sync";
import {
    attachVersioning,
    type VersioningHandle,
} from "../collaboration/versioning";
import { attachDocPeer, type AgentPeerHandle } from "./agent-peer";
import { EditStreamParser, replyHasBlocks } from "./edit-blocks";

/** The store surface a run drives. EditorStoreApi satisfies this. */
export interface AgentRunStore {
    subscribeRenderDataOps(listener: (ops: RenderDataOp[]) => void): () => void;
    getRenderDataSnapshot(): unknown;
    applyExternalRenderData(json: unknown): void;
    applyExternalRenderDataOps?(ops: RenderDataOp[]): void | Promise<void>;
    flushPendingInput?(): void | Promise<void>;
    getCursorSnapshot?(): CursorSnapshot;
    subscribeCursorChange?(
        listener: (cursor: CursorSnapshot) => void,
    ): () => void;
    toMarkdown(): string;
    insertText(
        text: string,
        cursorInfo?: CursorPosition,
        offset?: number,
    ): void;
    setSelection(
        target:
            | { search: string; occurrence?: number; collapse?: "start" | "end" }
            | { start: number; end?: number },
    ): { applied: boolean; reason?: string; start?: number; end?: number };
    replaceRanges(...edits: { start: number; end: number; text: string }[]): {
        applied: number;
        failed: number;
        results: { index: number; applied: boolean; reason?: string }[];
    };
}

export interface AgentIdentity {
    clientId: string;
    name: string;
    color: string;
}

export interface AgentRunFailure {
    /** Display label (SEARCH text, truncated). */
    anchor: string;
    reason: string;
    /** Full SEARCH text of a failed block — reflection retries embed it in
     *  the aider-style error report sent back to the model. */
    search?: string;
}

export interface AgentRunSummary {
    mode: "edits" | "content" | "empty";
    /** Blocks (or the caret insertion) successfully applied. */
    applied: number;
    failures: AgentRunFailure[];
}

export interface RunAgentOptions {
    /** Factory for the agent's own headless store — MUST be constructed with
     *  the same parsing options (inlineRules, tokenizers) as the user's
     *  provider, or serialized offsets would diverge. */
    createAgentStore: () => AgentRunStore;
    /** The collaboration session (a live room, or the local no-transport
     *  session the host mounts while AI collaboration is enabled). */
    session: { doc: Y.Doc; handle: RealtimeSyncHandle };
    identity: AgentIdentity;
    /** Where the user invoked the agent (caret after the "@" was removed).
     *  Content-mode output is inserted here. */
    invocationCursor: CursorPosition | null;
    /** The complete LLM reply (non-streaming request, SEARCH/REPLACE
     *  protocol). */
    complete: () => Promise<string>;
    /** How long each block's selection stays visible before the atomic
     *  replace lands (presence showcase; default 450ms, skipped in hidden
     *  tabs). */
    showSelectionMs?: number;
    /** Fired at the first visible action — the first block's region
     *  selected, or content mode's insertion. The UI hides the composer
     *  here. */
    onLocated?: () => void;
}

export interface AgentRunHandle {
    /** Stop consuming the stream and tear down (already-applied edits stay). */
    cancel(): void;
    done: Promise<AgentRunSummary>;
}

/** Aider-faithful SEARCH resolution ladder against the current markdown
 *  (mirrors replace_most_similar_chunk):
 *  1. perfect match;
 *  2. line-window match tolerating trailing whitespace AND a CONSISTENT
 *     leading-whitespace offset across all non-blank lines (aider's
 *     match_but_for_leading_whitespace);
 *  3. retry with stray blank first/last search lines stripped.
 *  First match wins (prompt demands unique blocks). Null = no match. */
export const resolveSearch = (
    md: string,
    search: string,
): { start: number; end: number } | null => {
    if (search.length === 0) return null;
    const exact = md.indexOf(search);
    if (exact !== -1) return { start: exact, end: exact + search.length };

    const rstrip = (s: string) => s.replace(/[ \t]+$/, "");
    const lstripLen = (s: string) => s.length - s.trimStart().length;
    const docLines = md.split("\n");
    // Line start offsets in the ORIGINAL text.
    const lineStarts: number[] = new Array(docLines.length);
    let acc = 0;
    for (let i = 0; i < docLines.length; i += 1) {
        lineStarts[i] = acc;
        acc += docLines[i].length + 1;
    }

    let searchLines = search.split("\n");
    // Tolerate stray blank first/last lines in the search block.
    while (searchLines.length > 0 && searchLines[0].trim() === "") {
        searchLines = searchLines.slice(1);
    }
    while (
        searchLines.length > 0 &&
        searchLines[searchLines.length - 1].trim() === ""
    ) {
        searchLines = searchLines.slice(0, -1);
    }
    if (searchLines.length === 0) return null;

    const n = searchLines.length;
    /** Window matcher: every line equal after rstrip, allowing ONE
     *  consistent leading-whitespace delta across all non-blank lines. */
    const windowMatches = (i: number): boolean => {
        let delta: number | null = null;
        for (let j = 0; j < n; j += 1) {
            const doc = rstrip(docLines[i + j]);
            const pat = rstrip(searchLines[j]);
            if (doc === pat) continue;
            if (doc.trimStart() !== pat.trimStart()) return false;
            if (doc.trim() === "") continue; // blank lines don't vote
            const d = lstripLen(doc) - lstripLen(pat);
            if (delta === null) delta = d;
            else if (delta !== d) return false;
        }
        return true;
    };
    for (let i = 0; i + n <= docLines.length; i += 1) {
        if (windowMatches(i)) {
            const start = lineStarts[i];
            const lastIdx = i + n - 1;
            const end = lineStarts[lastIdx] + docLines[lastIdx].length;
            return { start, end };
        }
    }
    return null;
};

export const runAgent = (options: RunAgentOptions): AgentRunHandle => {
    const { createAgentStore, session, identity, invocationCursor } = options;

    let cancelled = false;

    const agentStore = createAgentStore();

    const peer: AgentPeerHandle = attachDocPeer(
        agentStore as never,
        session.doc,
    );
    const versioning: VersioningHandle = attachVersioning(agentStore as never, {
        doc: session.doc,
        clientId: identity.clientId,
        name: identity.name,
        color: identity.color,
    });
    const virtualPeer: VirtualPeerHandle =
        session.handle.registerVirtualPeer(identity);

    const unsubCursor =
        agentStore.subscribeCursorChange?.((cursor) => {
            virtualPeer.updateCursor(cursor);
        }) ?? (() => {});

    const dispose = () => {
        unsubCursor();
        virtualPeer.dispose();
        versioning.dispose();
        peer.dispose();
    };

    const summary: AgentRunSummary = {
        mode: "empty",
        applied: 0,
        failures: [],
    };

    const showMs = options.showSelectionMs ?? 450;
    const showPause = () =>
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
            ? Promise.resolve()
            : new Promise((r) => setTimeout(r, showMs));

    const done = (async (): Promise<AgentRunSummary> => {
        let located = false;
        const markLocated = () => {
            if (located) return;
            located = true;
            options.onLocated?.();
        };

        try {
            // Fetch the COMPLETE reply, then parse it as a whole (aider
            // semantics — no partial application, no mid-stream state).
            const reply = await options.complete();
            if (cancelled) return summary;

            // Whole-reply mode detection (aider scans entire replies —
            // models routinely wrap blocks in chatter; a probe of the
            // first characters would misread that as content).
            const detectedMode = replyHasBlocks(reply) ? "edits" : "content";
            const parser = new EditStreamParser(detectedMode);
            const events = [...parser.push(reply), ...parser.finish()];
            summary.mode = detectedMode;

            // Collect fully-parsed blocks / content before touching the doc.
            const blocks: { search: string; replace: string }[] = [];
            let contentText = "";
            let pendingSearch: string | null = null;
            let pendingReplace = "";
            for (const event of events) {
                switch (event.kind) {
                    case "mode":
                        summary.mode =
                            event.mode === "edits" ? "edits" : "content";
                        break;
                    case "content":
                        contentText += event.text;
                        break;
                    case "search":
                        pendingSearch = event.search;
                        pendingReplace = "";
                        break;
                    case "replace":
                        pendingReplace += event.text;
                        break;
                    case "block-end":
                        if (pendingSearch !== null) {
                            blocks.push({
                                search: pendingSearch,
                                replace: pendingReplace,
                            });
                        }
                        pendingSearch = null;
                        pendingReplace = "";
                        break;
                    case "malformed":
                        pendingSearch = null;
                        pendingReplace = "";
                        summary.failures.push({
                            anchor: "(malformed block)",
                            reason: "malformed",
                            search: event.detail,
                        });
                        break;
                }
            }

            if (summary.mode === "content") {
                if (contentText.length > 0) {
                    markLocated();
                    const before = agentStore.toMarkdown();
                    if (invocationCursor) {
                        agentStore.insertText(contentText, invocationCursor);
                    } else {
                        // No invocation caret: place one explicitly at the
                        // end of the document, then insert.
                        agentStore.setSelection({ start: before.length });
                        agentStore.insertText(contentText);
                    }
                    if (agentStore.toMarkdown() === before) {
                        // insertText silently no-ops on a null or STALE
                        // caret (the invocation uuid may be gone by the
                        // time the reply arrives). Content must never be
                        // lost: append via the md-level pipeline, which
                        // cannot miss.
                        const sep =
                            before.length === 0 || before.endsWith("\n")
                                ? ""
                                : "\n\n";
                        agentStore.replaceRanges({
                            start: before.length,
                            end: before.length,
                            text: sep + contentText,
                        });
                    }
                    if (agentStore.toMarkdown() === before) {
                        summary.failures.push({
                            anchor: "(content)",
                            reason: "insert_failed",
                        });
                    } else {
                        summary.applied += 1;
                    }
                }
                return summary;
            }

            // Apply block by block: select (intent visible on every peer),
            // hold briefly, then land the block as ONE atomic edit.
            for (const block of blocks) {
                if (cancelled) break;
                const range = resolveSearch(
                    agentStore.toMarkdown(),
                    block.search,
                );
                if (range === null) {
                    // Unmatched SEARCH — skip, never force-apply.
                    summary.failures.push({
                        anchor: block.search.slice(0, 60),
                        reason: "not_found",
                        search: block.search,
                    });
                    continue;
                }
                agentStore.setSelection(range);
                markLocated();
                await showPause();
                if (cancelled) break;
                // Re-resolve in case a peer edited during the pause; the
                // showcase selection must not become a stale-offset write.
                const fresh = resolveSearch(
                    agentStore.toMarkdown(),
                    block.search,
                );
                if (fresh === null) {
                    summary.failures.push({
                        anchor: block.search.slice(0, 60),
                        reason: "not_found",
                        search: block.search,
                    });
                    continue;
                }
                const result = agentStore.replaceRanges({
                    start: fresh.start,
                    end: fresh.end,
                    text: block.replace,
                });
                if (result.applied > 0) summary.applied += 1;
                else {
                    summary.failures.push({
                        anchor: block.search.slice(0, 60),
                        reason: result.results[0]?.reason ?? "unknown",
                        search: block.search,
                    });
                }
            }

            // An edits-mode reply that produced nothing at all must
            // surface — silence is the worst failure mode.
            if (
                summary.mode === "edits" &&
                summary.applied === 0 &&
                summary.failures.length === 0
            ) {
                summary.failures.push({
                    anchor: "(malformed reply)",
                    reason: "no_blocks",
                });
            }
            return summary;
        } finally {
            dispose();
        }
    })();

    return {
        cancel: () => {
            cancelled = true;
        },
        done,
    };
};
