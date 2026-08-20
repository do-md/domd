import { CursorInfo, ParentRenderData } from "../../type";
import { getRenderDataById } from "../tree/getRenderDataById";
import { walkTextLeaves } from "./walkTextLeaves";


/**
 * Span-level cursor anchors (fine-grained positioning; drift-proof under
 * collaboration)
 * ---------------------------------------------------------------------------
 * A CursorInfo's primary coordinate is "render block uuid + text offset inside
 * that block". Under collaboration, a remote edit to a **different span** of
 * the same block invalidates that in-block offset (the text preceding the
 * cursor changed length), but the reference to the smallest text leaf (the
 * span) the cursor lives in does not change — a span is an immutable atom
 * (mergeInlineBlock invariant #1): unless a character change actually touches
 * it, its uuid never changes. splitTextSpans' up-front splitting plus the
 * burst-driven progressive subdivision make "same paragraph, different spans"
 * the normal case.
 *
 * So every time a cursor is placed we derive a span anchor alongside it
 * (spanUuid + spanOffset), and once a remote op lands we re-resolve the
 * in-block offset from that anchor:
 *   - span still there → prefix(span) + spanOffset; zero drift when another
 *                        span of the same block is edited;
 *   - span gone        → fall back to render uuid + offset (clamped to the
 *                        block's text length), which is exactly the behaviour
 *                        of the pre-anchor era — never worse;
 *   - block gone too   → null, and the caller decides (keep the local cursor
 *                        where it is / don't paint the remote cursor).
 *
 * The anchor is a pure model-layer concept and **never reaches the DOM** (span
 * elements carry no data attribute for it): resolving still yields block-level
 * coordinates, and DOM playback keeps taking the old getRenderDomByID +
 * getDomByCursor route.
 *
 * Offset affinity matches getDomByCursor / getNodeInfo: a leaf's tail is
 * inclusive (prefix < offset <= prefix + len), and offset === 0 belongs to the
 * first text leaf.
 */

/**
 * Derive a span anchor for a block-level coordinate. When the offset runs past
 * the model text (during a speculative-render burst the DOM leads the model
 * until the burst is applied) or the block has no text leaf at all, it returns
 * the primary coordinate without an anchor — once the apply lands, chain's
 * setStartCursorInfo_ re-derives on the new tree and the anchor heals itself.
 * If the block does not exist the cursor is returned as is (so existing
 * callers keep their semantics).
 */
export const withSpanAnchor = (
    cursor: CursorInfo,
    root: ParentRenderData,
): CursorInfo => {
    const block = getRenderDataById(cursor.uuid, root);
    if (!block) return cursor;
    let anchor: { spanUuid: string; spanOffset: number } | null = null;
    walkTextLeaves(block, (leaf, prefix) => {
        const len = leaf.text_.length;
        if (
            (cursor.offset > prefix && cursor.offset <= prefix + len) ||
            cursor.offset === 0
        ) {
            anchor = {
                spanUuid: leaf.uuid_,
                spanOffset: cursor.offset - prefix,
            };
            return true;
        }
        return false;
    });
    if (!anchor) {
        return { uuid: cursor.uuid, offset: cursor.offset };
    }
    return { uuid: cursor.uuid, offset: cursor.offset, ...(anchor as {
        spanUuid: string;
        spanOffset: number;
    }) };
};