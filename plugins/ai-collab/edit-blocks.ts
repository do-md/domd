/**
 * Streaming parser for Aider-style SEARCH/REPLACE edit blocks — the
 * industry-proven agent text-editing format. Marker regexes and structure
 * tolerance mirror aider/coders/editblock_coder.py:
 *
 *     <<<<<<< SEARCH
 *     exact existing text
 *     =======
 *     new text
 *     >>>>>>> REPLACE
 *
 * Aider-faithful behaviours:
 *   - HEAD/DIVIDER/UPDATED regexes match aider's (5-9 marker chars,
 *     optional trailing ">" on HEAD);
 *   - a REPLACE section may be terminated by a DIVIDER instead of the
 *     closing marker — that starts the NEXT block's SEARCH directly
 *     (aider: "Expected `>>>>>>> REPLACE` or `=======`");
 *   - a structurally broken block (SEARCH never reaches its divider) is
 *     NOT guess-repaired: it surfaces as a "malformed" event so the caller
 *     can reflect the error back to the model for a retry — aider's actual
 *     reliability mechanism.
 *
 * The runner consumes COMPLETE replies (non-streaming, aider semantics):
 * blocks are collected in full before anything touches the document, and
 * an unterminated block is malformed — never applied. Incremental push()
 * remains supported (and adversarially tested) but is not load-bearing.
 */

export type EditStreamEvent =
    | { kind: "mode"; mode: "edits" | "content" }
    | { kind: "content"; text: string }
    | { kind: "search"; search: string }
    | { kind: "replace"; text: string }
    | { kind: "block-end" }
    | { kind: "malformed"; detail: string };

// aider: HEAD = ^<{5,9} SEARCH>?\s*$ (also tolerate a missing space)
const OPEN_RE = /^<{5,9} ?SEARCH>?\s*$/;
const DIVIDER_RE = /^={5,9}\s*$/;
const CLOSE_RE = /^>{5,9} ?REPLACE\s*$/;
const FENCE_RE = /^```[a-zA-Z0-9_-]*\s*$/;
const OPEN_PREFIX = "<<<<<<<";

/** True when the reply contains a SEARCH marker line ANYWHERE — aider
 *  scans whole replies for blocks (models routinely prefix them with
 *  chatter), so mode detection must too. */
export const replyHasBlocks = (reply: string): boolean =>
    /^<{5,9} ?SEARCH>?\s*$/m.test(reply);

export class EditStreamParser {
    private buffer = "";
    private mode: "pending" | "edits" | "content" = "pending";
    private section: "idle" | "search" | "replace" = "idle";
    private searchLines: string[] = [];
    private pendingNewline = false;
    /** The current line's head was already flushed as REPLACE content —
     *  its remainder must never be marker-checked (a tail like "======="
     *  inside a longer content line is not a divider). */
    private midLine = false;

    /** Presetting the mode (known from a whole-reply scan) skips the
     *  head-of-stream probe — in "edits" mode any chatter around the
     *  blocks is ignored by the idle section. */
    constructor(mode?: "edits" | "content") {
        if (mode) this.mode = mode;
    }

    push(chunk: string): EditStreamEvent[] {
        this.buffer += chunk;
        return this.drain(false);
    }

    finish(): EditStreamEvent[] {
        const events = this.drain(true);
        // Aider semantics, exactly: a block that never closed is malformed
        // and is NEVER applied (the caller buffers REPLACE text until
        // block-end, so an unterminated block costs nothing).
        if (this.section !== "idle") {
            events.push({
                kind: "malformed",
                detail:
                    this.section === "search"
                        ? "Expected `=======`"
                        : "Expected `>>>>>>> REPLACE` or `=======`",
            });
            this.section = "idle";
        }
        return events;
    }

    private drain(final: boolean): EditStreamEvent[] {
        const events: EditStreamEvent[] = [];

        if (this.mode === "pending") {
            const probe = this.buffer.trimStart();
            if (probe.length === 0 && !final) return events;
            const afterFence = FENCE_RE.test(probe.split("\n", 1)[0] ?? "")
                ? probe.slice(probe.indexOf("\n") + 1).trimStart()
                : probe;
            if (afterFence.startsWith(OPEN_PREFIX)) {
                this.mode = "edits";
                events.push({ kind: "mode", mode: "edits" });
            } else if (
                final ||
                probe.includes("\n") ||
                (probe.length >= OPEN_PREFIX.length &&
                    !probe.startsWith(OPEN_PREFIX)) ||
                !OPEN_PREFIX.startsWith(probe)
            ) {
                this.mode = "content";
                events.push({ kind: "mode", mode: "content" });
            } else {
                return events; // still a plausible marker prefix — wait
            }
        }

        if (this.mode === "content") {
            if (this.buffer.length > 0) {
                events.push({ kind: "content", text: this.buffer });
                this.buffer = "";
            }
            return events;
        }

        // EDIT mode: consume complete lines; keep the trailing partial.
        const lines = this.buffer.split("\n");
        this.buffer = final ? "" : (lines.pop() ?? "");
        if (final && lines.length && lines[lines.length - 1] === "") {
            lines.pop();
        }

        let replaceRun = "";
        const flushReplace = () => {
            if (replaceRun.length > 0) {
                events.push({ kind: "replace", text: replaceRun });
                replaceRun = "";
            }
        };
        const enterSearch = () => {
            this.section = "search";
            this.searchLines = [];
        };
        const enterReplace = () => {
            this.section = "replace";
            this.pendingNewline = false;
            events.push({
                kind: "search",
                search: this.searchLines.join("\n"),
            });
        };

        for (const line of lines) {
            if (this.midLine) {
                // Remainder of a line whose head already streamed out as
                // REPLACE content: append verbatim, no marker checks.
                this.midLine = false;
                if (this.section === "replace") {
                    replaceRun += line;
                    this.pendingNewline = true;
                }
                continue;
            }
            if (this.section === "idle") {
                if (OPEN_RE.test(line)) enterSearch();
                // Fences / blank lines / stray prose between blocks: ignore.
                continue;
            }
            if (this.section === "search") {
                if (DIVIDER_RE.test(line)) {
                    enterReplace();
                } else if (CLOSE_RE.test(line) || OPEN_RE.test(line)) {
                    // Structurally broken block (the divider never came).
                    // No guess-repair — report it for reflection (aider:
                    // "Expected `=======`"). An OPEN restarts a new block.
                    events.push({
                        kind: "malformed",
                        detail: "Expected `=======`",
                    });
                    if (OPEN_RE.test(line)) enterSearch();
                    else this.section = "idle";
                } else {
                    this.searchLines.push(line);
                }
                continue;
            }
            // section === "replace"
            if (CLOSE_RE.test(line)) {
                flushReplace();
                this.pendingNewline = false; // boundary newline, dropped
                this.section = "idle";
                events.push({ kind: "block-end" });
            } else if (DIVIDER_RE.test(line)) {
                // aider variant: a divider ends this block AND starts the
                // next block's SEARCH directly.
                flushReplace();
                this.pendingNewline = false;
                events.push({ kind: "block-end" });
                enterSearch();
            } else {
                if (this.pendingNewline) replaceRun += "\n";
                replaceRun += line;
                this.pendingNewline = true; // held until more content
            }
        }

        // Stream the partial REPLACE line eagerly UNLESS it could still
        // become a terminator line. A terminator arrives split across
        // chunks (">>>>>>>", " REPL", "ACE\n"), so any partial starting
        // with ">" or "=" (or pure whitespace) must be held until its
        // newline arrives and the LINE-level check runs — flushing early
        // would type the marker into the document. The cost: quoted lines
        // ("> …") appear line-at-once instead of live; correctness wins.
        if (this.section === "replace" && this.buffer.length > 0) {
            const head = this.buffer.trimStart();
            // A mid-line remainder can never be a marker — always flush it.
            const holdable =
                !this.midLine &&
                (head.length === 0 ||
                    head.startsWith(">") ||
                    head.startsWith("="));
            if (!holdable) {
                if (this.pendingNewline) {
                    replaceRun += "\n";
                    this.pendingNewline = false;
                }
                replaceRun += this.buffer;
                this.buffer = "";
                this.midLine = true;
            }
        }
        flushReplace();
        return events;
    }
}
