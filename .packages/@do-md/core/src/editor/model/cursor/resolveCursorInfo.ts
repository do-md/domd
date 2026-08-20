import { withSpanAnchor } from "./withSpanAnchor";
import { CursorInfo, ParentRenderData } from "../../type";
import { getRenderDataById } from "../tree/getRenderDataById";
import { blockTextLength } from "./blockTextLength";
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
 * Resolve a cursor against the current tree into block-level coordinates via
 * its anchor, and hand back a freshly derived anchor with it. spanUuid wins
 * (leaf still there → prefix + clamp(spanOffset)); if that fails it falls back
 * to render uuid + offset (clamped, then re-anchored in place). Returns null
 * when the block no longer exists.
 */
export const resolveCursorInfo = (
    cursor: CursorInfo,
    root: ParentRenderData,
): CursorInfo | null => {
    const block = getRenderDataById(cursor.uuid, root);
    if (!block) return null;
    if (cursor.spanUuid) {
        let resolved: CursorInfo | null = null;
        walkTextLeaves(block, (leaf, prefix) => {
            if (leaf.uuid_ !== cursor.spanUuid) return false;
            const spanOffset = Math.min(
                cursor.spanOffset ?? 0,
                leaf.text_.length,
            );
            resolved = {
                uuid: cursor.uuid,
                offset: prefix + spanOffset,
                spanUuid: leaf.uuid_,
                spanOffset,
            };
            return true;
        });
        if (resolved) return resolved;
    }
    // The span was touched and replaced: fall back to the primary coordinate
    // (clamped), then re-anchor at the fallback position.
    return withSpanAnchor(
        {
            uuid: cursor.uuid,
            offset: Math.min(cursor.offset, blockTextLength(block)),
        },
        root,
    );
};