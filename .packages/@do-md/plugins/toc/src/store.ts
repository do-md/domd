/**
 * Headless outline state machine — a zenith store over the kernel's public
 * snapshot/ops surface. No React, no DOM: the UI layer renders this state;
 * scroll tracking lives in ./spy.
 *
 * Update strategy: the outline is rebuilt by a FULL scan (the heading count
 * of a real document is O(dozens); a full rebuild is cheap and always
 * self-consistent), but scans are gated by `opsAffectOutline` — the cheap
 * relevance filter over the op batch — so the overwhelmingly common case,
 * typing inside a paragraph, touches nothing. A rescan that reproduces the
 * same outline is swallowed (`outlineEquals`), so subscribers only ever see
 * real outline changes.
 */
import { ZenithStore } from "@do-md/zenith";
import {
    OutlineIndex,
    OutlineNode,
    OutlineOp,
    TocHeading,
    buildOutline,
    opsAffectOutline,
    outlineEquals,
} from "./outline";

/**
 * The slice of the kernel's EditorStore this engine consumes — structural,
 * so any store satisfying it works (and a headless kernel store in tests
 * does too). The required members are public kernel API on every supported
 * kernel; the optional ones (`resolveBlockOffset` ships with the kernel
 * this feature was built against) only gate caret placement on jump —
 * older kernels degrade to scroll-only, never break.
 */
export interface TocEditor {
    getRenderDataSnapshot(): OutlineNode;
    subscribeRenderDataOps(listener: (ops: unknown[]) => void): () => void;
    /** Optional: block uuid → absolute source range (kernel >= 0.11.7). */
    resolveBlockOffset?(uuid: string): { start: number; end: number } | null;
    /** Optional: place the model caret at an absolute source offset. */
    setSelection?(target: { start: number; end?: number }): {
        applied: boolean;
    };
    /** Optional: hand focus back to the editor after a panel click. */
    focus?(): void;
}

export interface TocState {
    /** Document order, flat; render nesting comes from `depth`. */
    headings: TocHeading[];
    /** Scroll-spy result: the heading whose section fills the viewport.
     *  null = above the first heading, or no headings at all. */
    activeUuid: string | null;
}

export class TocStore extends ZenithStore<TocState> {
    private editor_: TocEditor | null = null;
    private unsubscribeOps_: (() => void) | null = null;
    private index_: OutlineIndex | null = null;
    /** Timestamp of the last pinActive(); null = not pinned. */
    private pinnedAt_: number | null = null;
    /** Diagnostic: full scans since attach. The verify harness asserts the
     *  op relevance filter through it; not part of the UI contract. */
    public scanCount = 0;

    constructor() {
        super({ headings: [], activeUuid: null });
    }

    /** Wire the engine to an editor store and scan immediately. Idempotent
     *  per editor; call the returned dispose (or detach()) on unmount. */
    public attach(editor: TocEditor): () => void {
        if (this.editor_ === editor) return () => this.detach();
        this.detach();
        this.editor_ = editor;
        this.scanCount = 0;
        this.scan_();
        this.unsubscribeOps_ = editor.subscribeRenderDataOps((ops) => {
            if (
                this.index_ === null ||
                opsAffectOutline(ops as OutlineOp[], this.index_)
            ) {
                this.scan_();
            }
        });
        return () => this.detach();
    }

    public detach() {
        this.unsubscribeOps_?.();
        this.unsubscribeOps_ = null;
        this.editor_ = null;
        this.index_ = null;
        this.pinnedAt_ = null;
        if (this.state.headings.length > 0 || this.state.activeUuid !== null) {
            this.produce((draft) => {
                draft.headings = [];
                draft.activeUuid = null;
            });
        }
    }

    /**
     * Pin the highlight on a just-jumped heading. A clicked heading near the
     * document end often CANNOT reach the container top (not enough content
     * below), so an honest scroll-position arbitration would immediately
     * elect a different heading — most visibly the bottom clamp handing the
     * highlight to the LAST heading. Pinning keeps the clicked entry active;
     * the scroll spy honors the pin and releases it on the first genuine
     * user scroll (see bindTocSpy — the jump's own scroll events are
     * swallowed by a grace window).
     */
    public pinActive(uuid: string) {
        this.pinnedAt_ = Date.now();
        this.setActive(uuid);
    }

    /** Milliseconds since pinActive(), or null when not pinned. */
    public pinAge(): number | null {
        return this.pinnedAt_ === null ? null : Date.now() - this.pinnedAt_;
    }

    /** Hand the highlight back to the scroll spy's arbitration. */
    public unpin() {
        this.pinnedAt_ = null;
    }

    /**
     * Place the editor caret at the start of a heading's TEXT (right after
     * the `#` marker run — the Tiptap navigateToHeading semantics: a TOC
     * click both scrolls and moves the selection). Model-level only; the
     * caller owns the visual scroll (`scrollToHeading`).
     *
     * Degrades honestly: false when the kernel predates
     * `resolveBlockOffset`, the heading vanished, or the placement failed —
     * the caller simply keeps scroll-only behavior.
     */
    public moveCaretToHeading(uuid: string): boolean {
        const editor = this.editor_;
        if (!editor?.resolveBlockOffset || !editor.setSelection) return false;
        const heading = this.state.headings.find((h) => h.uuid === uuid);
        if (!heading) return false;
        const range = editor.resolveBlockOffset(uuid);
        if (!range) return false;
        // A top-level heading serializes as `#`.repeat(level) + " " + text;
        // land on the first text character. The clamp covers a content-less
        // heading whose serialization ends at (or inside) the marker run.
        const target = Math.min(range.start + heading.level + 1, range.end);
        const applied = editor.setSelection({ start: target }).applied;
        if (applied) editor.focus?.();
        return applied;
    }

    /** Written by the scroll spy (bindTocSpy). No-op when unchanged, so the
     *  spy can call it every frame without notifying subscribers. */
    public setActive(uuid: string | null) {
        if (this.state.activeUuid === uuid) return;
        this.produce((draft) => {
            draft.activeUuid = uuid;
        });
    }

    private scan_() {
        const editor = this.editor_;
        if (!editor) return;
        this.scanCount += 1;
        const index = buildOutline(editor.getRenderDataSnapshot());
        this.index_ = index;
        if (outlineEquals(this.state.headings, index.headings)) return;
        const activeGone =
            this.state.activeUuid !== null &&
            !index.headings.some((h) => h.uuid === this.state.activeUuid);
        // A vanished heading must not stay highlighted (or pinned); the spy
        // recomputes the real successor on its next pass.
        if (activeGone) this.pinnedAt_ = null;
        this.produce((draft) => {
            draft.headings = index.headings;
            if (activeGone) draft.activeUuid = null;
        });
    }
}
