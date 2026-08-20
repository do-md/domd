import { CursorMarker } from "../../constant";
import { getPrevGraphemeLength } from "./getPrevGraphemeLength";

/**
 * Block-text editing primitives: immutable and chainable.
 *
 * ## What it owns
 * "Editing a block of text in cursor coordinates" — the serialized markdown
 * text, the cursor sentinel (CursorMarker), and user-perceived characters
 * (grapheme clusters). Every hand-rolled slice+concat in controller / chain
 * should collapse into this class.
 *
 * ## What it does NOT own (important — do not stuff these in)
 * 1. **Markdown dialect**: code-block ZWSP padding, the `[ ] ` checkbox prefix,
 *    ``` fence boundaries. These are the most volatile part of the system, and
 *    the moment they move in, this class degrades from "text primitive" into
 *    "markdown editor" — while controller / chain / the future commands layer
 *    all depend on it. Hang dialect rules on the chain through the `apply()` /
 *    `when()` escape hatches; keep them out of the class.
 * 2. **Read-only slicing**: the parser's (data-parse) scanning, serialization
 *    and regex matching. Those are code-unit exact and carry no cursor
 *    semantics, so wrapping them in an object is a net loss.
 * 3. **Transforms that take a string and return something else**: they break
 *    the chaining algebra on the spot. Queries (returning boolean/number) are
 *    fine as getters; a transform must be text→text.
 *
 * ## Coordinate conventions (hard-won — do not mix them up)
 * - **Every index is a UTF-16 code-unit index**, matching cursor coordinates
 *   and DOM offsets.
 * - **`deleteBackward` / `deleteForward` are the only grapheme-aware methods.**
 *   Backspace has to delete "one user-perceived character", or it cuts through
 *   an emoji surrogate pair / a ZWJ sequence / a flag and leaves an orphan code
 *   unit that renders as `�`. Do not generalize that semantic to any other
 *   method.
 *
 * @example Backspace, leaving the cursor at the deletion point
 * TextOperator.of(text).deleteBackward(index, { markCursor: true }).text
 *
 * @example Dialect stays outside, the chain stays unbroken
 * TextOperator.of(codeText)
 *     .replaceAll(ZeroWidthSpace, "")
 *     .splice(index, 0, "\n")
 *     .when(op => op.endsWith(`\n${CursorMarker}`), op => op.append(ZeroWidthSpace))
 *     .text
 */
export class TextOperator {
    private readonly raw_: string;

    private constructor(text: string) {
        this.raw_ = text;
    }

    /** The single construction entry point (`new` stays private so `new` and
     *  `of` never end up mixed in the codebase). */
    public static of(text: string | null | undefined): TextOperator {
        return new TextOperator(text ?? "");
    }

    // ========================================================================
    // Exits and queries — read-only. The chain ends here; that is normal, do
    // not force it back into chaining.
    // ========================================================================

    /** Chain exit: get the string back. */
    public get text(): string {
        return this.raw_;
    }

    /** UTF-16 code-unit length (not the number of grapheme clusters). */
    public get length(): number {
        return this.raw_.length;
    }

    public get isEmpty(): boolean {
        return this.raw_.length === 0;
    }

    public toString(): string {
        return this.raw_;
    }

    public startsWith(search: string): boolean {
        return this.raw_.startsWith(search);
    }

    public endsWith(search: string): boolean {
        return this.raw_.endsWith(search);
    }

    public includes(search: string): boolean {
        return this.raw_.includes(search);
    }

    public indexOf(search: string, from = 0): number {
        return this.raw_.indexOf(search, from);
    }

    public equals(other: string | TextOperator): boolean {
        return this.raw_ === (typeof other === "string" ? other : other.raw_);
    }

    // ========================================================================
    // General editing primitives — all code-unit based. splice is the
    // foundation; everything else is a semantic wrapper around it.
    // ========================================================================

    /**
     * The foundation: delete `deleteCount` code units and insert `insert`.
     * Out-of-range indices are clamped (never String.slice's negative = count
     * from the end semantics, which is a footgun).
     */
    public splice(
        start: number,
        deleteCount: number,
        insert: string = "",
    ): TextOperator {
        const from = this.clamp_(start);
        const to = this.clamp_(from + Math.max(0, deleteCount));
        return new TextOperator(
            this.raw_.slice(0, from) + insert + this.raw_.slice(to),
        );
    }

    public insert(index: number, text: string): TextOperator {
        return this.splice(index, 0, text);
    }

    public delete(start: number, deleteCount: number): TextOperator {
        return this.splice(start, deleteCount);
    }

    /** Replace the [start, end) range; start > end is swapped rather than
     *  failing silently. */
    public replaceRange(
        start: number,
        end: number,
        text: string,
    ): TextOperator {
        const [from, to] = this.orderedRange_(start, end);
        return this.splice(from, to - from, text);
    }

    public append(text: string): TextOperator {
        return new TextOperator(this.raw_ + text);
    }

    public prepend(text: string): TextOperator {
        return new TextOperator(text + this.raw_);
    }

    /**
     * Wrap the [start, end) range in `open` / `close` (`**bold**`,
     * `` `code` ``, `==highlight==`).
     *
     * ⚠️ Do not build this out of two inserts: `insert(start)` pushes `end`
     * along by `open.length`, which is a hidden ordering trap. This method
     * computes all three slices at once, so it is **order-independent**. The
     * same invariant holds for batch replacement (groups must run in descending
     * order).
     *
     * After wrapping, a cursor that sat at `end` moves to `end + open.length`.
     */
    public wrap(
        start: number,
        end: number,
        open: string,
        close: string = open,
    ): TextOperator {
        const [from, to] = this.orderedRange_(start, end);
        return new TextOperator(
            this.raw_.slice(0, from) +
                open +
                this.raw_.slice(from, to) +
                close +
                this.raw_.slice(to),
        );
    }

    /** Take a substring and keep editing. ⚠️ The coordinate system shifts with
     *  it: every later index in the chain is relative to the new string. */
    public slice(start: number, end?: number): TextOperator {
        const from = this.clamp_(start);
        const to = end === undefined ? this.raw_.length : this.clamp_(end);
        return new TextOperator(this.raw_.slice(from, Math.max(from, to)));
    }

    /**
     * Replace the first match. **The replacement string is treated literally**
     * — the function form sidesteps `String.replace`'s expansion of `$$` /
     * `$&` / `` $` `` / `$'`.
     *
     * This is not fastidiousness: code blocks are exactly where those symbols
     * live (shell `$$` = PID, awk/sed/perl `$&`). Measured: backspacing the `x`
     * at the end of an `echo $$x` line inside a code block, a bare
     * String.replace folds the `$$` in the replacement down to `$` and silently
     * eats one of the user's characters.
     *
     * When capture-group backreferences (`$1`) really are wanted, go through
     * `apply(t => t.replace(re, "$1..."))` and keep that semantic explicit at
     * the call site.
     */
    public replace(search: string | RegExp, replacement: string): TextOperator {
        return new TextOperator(this.raw_.replace(search, () => replacement));
    }

    /** Replace every match. The replacement string is treated literally, for
     *  the same reason as `replace`. */
    public replaceAll(search: string, replacement: string): TextOperator {
        return new TextOperator(this.raw_.replaceAll(search, () => replacement));
    }

    public trim(): TextOperator {
        return new TextOperator(this.raw_.trim());
    }

    // ========================================================================
    // Grapheme-cluster aware — these two methods are the only ones that work
    // in "user-perceived characters".
    // ========================================================================

    /**
     * Backspace: delete the `count` grapheme clusters before `index` (an emoji
     * / ZWJ sequence / flag / skin-tone modifier goes as a whole).
     *
     * With `markCursor: true` a cursor sentinel is planted at the deletion
     * point — where the deletion starts is decided by grapheme-cluster
     * boundaries, so the caller **cannot work it out**, which is why this
     * option has to be offered by this method (insert / splice callers already
     * know where they landed, so they get no such option — no need to bloat the
     * API).
     */
    public deleteBackward(
        index: number,
        options: { count?: number; markCursor?: boolean } = {},
    ): TextOperator {
        const { count = 1, markCursor = false } = options;
        const end = this.clamp_(index);
        let start = end;
        for (let i = 0; i < count && start > 0; i++) {
            start -= getPrevGraphemeLength(this.raw_, start);
        }
        return this.splice(start, end - start, markCursor ? CursorMarker : "");
    }

    /** The Delete key: delete the `count` grapheme clusters after `index`.
     *  Symmetric with backspace. */
    public deleteForward(
        index: number,
        options: { count?: number; markCursor?: boolean } = {},
    ): TextOperator {
        const { count = 1, markCursor = false } = options;
        const start = this.clamp_(index);
        let end = start;
        for (let i = 0; i < count && end < this.raw_.length; i++) {
            end += getNextGraphemeLength(this.raw_, end);
        }
        return this.splice(start, end - start, markCursor ? CursorMarker : "");
    }

    // ========================================================================
    // Cursor sentinel protocol — CursorMarker = '\uE000' (private use area, so
    // it never shows up in real text).
    //
    // Why a sentinel: an edit is serialize to markdown → change the text →
    // reparse into a new tree. After the reparse every node is a new object and
    // offsets have drifted as syntax symbols were added or removed, so the old
    // (uuid, offset) means nothing in the new tree. So the cursor is buried in
    // the text and gets parsed along with it — the parser finds the sentinel
    // with indexOf, strips it out of text_, and reports the new landing spot
    // through onCursorFound_. The parser computes the cursor position; the
    // editing code never derives it.
    //
    // Write side = markCursor / markCursorAtEnd; consume side =
    // replaceBetweenCursors.
    // ========================================================================

    /** Plant a cursor sentinel at `index`. */
    public markCursor(index: number): TextOperator {
        return this.splice(index, 0, CursorMarker);
    }

    /** Plant a cursor sentinel at the end of the text. */
    public markCursorAtEnd(): TextOperator {
        return this.append(CursorMarker);
    }

    /** How many sentinels the text holds. A selection plants one at each end,
     *  so the usual values are 0 / 1 / 2. */
    public get cursorCount(): number {
        let n = 0;
        for (let i = 0; i < this.raw_.length; i++) {
            if (this.raw_[i] === CursorMarker) n++;
        }
        return n;
    }

    /** Index of the first sentinel, or -1 when there is none. */
    public get cursorIndex(): number {
        return this.raw_.indexOf(CursorMarker);
    }

    /** Index of the last sentinel, or -1 when there is none. */
    public get lastCursorIndex(): number {
        return this.raw_.lastIndexOf(CursorMarker);
    }

    /** Strip every sentinel (back to clean text). */
    public stripCursor(): TextOperator {
        return this.replaceAll(CursorMarker, "");
    }

    /**
     * Selection replacement: throw away everything between the first and the
     * last sentinel, put `insert` there, and plant a new cursor at the seam.
     *
     * ```
     *   AAA ␀ BBB ␀ CCC        BBB = the selected content
     * → AAA + insert + ␀ + CCC
     * ```
     *
     * Taking the **first and last** sentinel rather than fixed indices is
     * deliberate: a same-block selection injects 2 of them (splitting the text
     * into 3 parts), but there are cases that inject only 1 (2 parts), and both
     * have to come out right.
     *
     * ⚠️ **The caller must guard on `cursorCount` first**: a same-block edit
     * requires ≥ 1, a cross-block edit requires exactly 2. Too few means a
     * selection endpoint failed to land, and the edit must fall back to the
     * full-reparse path — this guard is the safety net of the scoped reparse,
     * do not skip it. With no sentinel present this method returns itself
     * (a no-op) rather than throwing.
     *
     * `pad` is the dialect seam: a code block emptied by the selection needs a
     * placeholder put back, and that rule belongs to the markdown dialect — it
     * stays out of this class and is injected by the caller.
     */
    public replaceBetweenCursors(
        insert: string,
        options: { pad?: (before: string, after: string) => string } = {},
    ): TextOperator {
        const first = this.raw_.indexOf(CursorMarker);
        if (first === -1) return this;
        const last = this.raw_.lastIndexOf(CursorMarker);

        const before = this.raw_.slice(0, first) + insert;
        const after = this.raw_.slice(last + CursorMarker.length);
        const pad = options.pad ? options.pad(before, after) : "";

        return new TextOperator(before + CursorMarker + pad + after);
    }

    // ========================================================================
    // Combinators — keep dialect outside the class without breaking the chain.
    // ========================================================================

    /**
     * Escape hatch: hang any pure `(text) => text` function on the chain.
     * Markdown dialect rules (padIfEmptyCodeBlock, stripping the checkbox
     * prefix, and so on) go through here — do not move them into this class
     * just to make them chainable.
     */
    public apply(fn: (text: string) => string): TextOperator {
        return new TextOperator(fn(this.raw_));
    }

    /** Conditional branch: run `fn` only when the condition holds, so logic
     *  like "delete, then decide whether to pad" need not break the chain. */
    public when(
        condition: boolean | ((op: TextOperator) => boolean),
        fn: (op: TextOperator) => TextOperator,
    ): TextOperator {
        const ok =
            typeof condition === "function" ? condition(this) : condition;
        return ok ? fn(this) : this;
    }

    /** For debugging: peek at the current text without changing the chain. */
    public tap(fn: (text: string) => void): TextOperator {
        fn(this.raw_);
        return this;
    }

    // ========================================================================
    // Internals
    // ========================================================================

    /**
     * Normalize an index into [0, length].
     * An external index must never go straight to String.slice — `slice(0, -1)`
     * is read as "count back from the end", so one stray negative offset
     * silently eats the last character instead of failing loudly.
     */
    private clamp_(index: number): number {
        if (!Number.isFinite(index)) return 0;
        if (index <= 0) return 0;
        const i = Math.floor(index);
        return i > this.raw_.length ? this.raw_.length : i;
    }

    private orderedRange_(start: number, end: number): [number, number] {
        const a = this.clamp_(start);
        const b = this.clamp_(end);
        return a <= b ? [a, b] : [b, a];
    }
}

/** Code-unit length of the grapheme cluster after the cursor (the forward dual
 *  of `getPrevGraphemeLength`). */
const graphemeSegmenter: Intl.Segmenter | null =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;

function getNextGraphemeLength(text: string, index: number): number {
    if (index < 0) index = 0;
    if (index >= text.length) return 0;
    if (graphemeSegmenter) {
        for (const seg of graphemeSegmenter.segment(text.slice(index))) {
            return seg.segment.length;
        }
        return 1;
    }
    // Fallback for old environments without Segmenter: basic surrogate pairs
    // only
    const hi = text.charCodeAt(index);
    if (hi >= 0xd800 && hi <= 0xdbff && index + 1 < text.length) {
        const lo = text.charCodeAt(index + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
    }
    return 1;
}
