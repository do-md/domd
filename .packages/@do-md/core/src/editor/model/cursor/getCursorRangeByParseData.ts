import { DATA_RENDER_ID } from "../../../data-parse/constant";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
} from "../../type";
import { blockTextLength } from "./blockTextLength";

/**
 * A collapsed caret is `start === end`; a selection has them apart. Both cursors
 * always carry the same `uuid` — the render block `parseData` resolves to — so a
 * range produced here is single-block by construction.
 */
export interface CursorRange {
    startCursorInfo: CursorInfo;
    endCursorInfo: CursorInfo;
}

// Pre-order DFS sum of `text_` lengths that precede `target` inside `container`.
// This matches the offset convention `getNodeInfo` walks (children visited in
// order). Returns null when `target` is not in `container`'s subtree (matched by
// reference first, uuid as a fallback for cloned trees).
// (Can't reuse walkTextLeaves: `target` may be a container node rather than a
// text leaf, and the callback only fires on text leaves — it would never hit.)
const textOffsetWithin = (
    container: ParentRenderData | RenderData,
    target: ParentRenderData | RenderData,
): number | null => {
    let acc = 0;
    let result: number | null = null;

    const visit = (node: ParentRenderData | RenderData): boolean => {
        if (node === target || node.uuid_ === target.uuid_) {
            result = acc;
            return true; // stop: text before `target` only
        }
        if (typeof node.text_ === "string") {
            acc += node.text_.length;
            return false;
        }
        if (node.children_) {
            for (const child of node.children_) {
                if (visit(child)) return true;
            }
        }
        return false;
    };

    visit(container);
    return result;
};

// Nearest node carrying DATA_RENDER_ID that is `target` itself or one of its
// ancestors within `root`. This is the "walk up" the node alone can't do (render
// nodes hold no parent pointer), so it needs the owning tree. Matches `target`
// by reference-or-uuid.
const findRenderBlockFor = (
    root: ParentRenderData | RootRenderData,
    target: ParentRenderData | RenderData,
): ParentRenderData | RenderData | null => {
    type Frame = {
        node: ParentRenderData | RenderData;
        closestRender: ParentRenderData | RenderData | null;
    };
    const stack: Frame[] = [{ node: root, closestRender: null }];

    while (stack.length) {
        const { node, closestRender: parentRender } = stack.pop()!;
        const closestRender = node.htmlProps_[DATA_RENDER_ID]
            ? node
            : parentRender;

        if (node === target || node.uuid_ === target.uuid_) {
            return closestRender;
        }

        if (node.children_) {
            for (let i = node.children_.length - 1; i >= 0; i--) {
                stack.push({ node: node.children_[i], closestRender });
            }
        }
    }

    return null;
};

// Shallowest descendant (BFS) carrying DATA_RENDER_ID. Fallback for when a
// wrapper/root is passed that only *contains* render blocks — pick the first
// one rather than failing.
const firstRenderDescendant = (
    node: ParentRenderData | RenderData,
): ParentRenderData | RenderData | null => {
    const queue: (ParentRenderData | RenderData)[] = [node];
    while (queue.length) {
        const cur = queue.shift()!;
        if (cur.htmlProps_[DATA_RENDER_ID]) return cur;
        if (cur.children_) queue.push(...cur.children_);
    }
    return null;
};

/**
 * Robust range-returning successor to `getCursorInfoByParseData` — call sites
 * are being migrated onto this and the old function will be retired.
 *
 * Resolves the *render block* (nearest node with DATA_RENDER_ID) for `parseData`
 * and expresses where `parseData` sits inside it as a cursor range:
 *
 *   1. `parseData` carries DATA_RENDER_ID itself      → selects the whole block
 *      (`start = 0`, `end =` block text length).
 *   2. `parseData` is nested under a render block      → selects exactly
 *      `parseData`'s text span. Requires `root` to walk up, since render nodes
 *      hold no parent pointer.
 *   3. `parseData` merely *contains* render blocks     → selects the first one.
 *
 * Offsets use the `getNodeInfo` / `toMarkdown` convention (pre-order DFS sum of
 * raw `text_` lengths). Both returned cursors share the block's uuid, so the
 * range is always single-block. Returns `null` — never throws — when no render
 * block can be resolved, so callers can branch safely.
 *
 * Unlike the old function it does NOT scan for the *last* render block in the
 * subtree; it anchors on the block that actually owns `parseData`. That is the
 * robustness gain: passing a symbol/atomic leaf now resolves to its containing
 * block (given `root`) instead of returning null.
 *
 * @param parseData node to locate. Ideally carries DATA_RENDER_ID itself.
 * @param root      tree `parseData` lives in; needed only to search upward when
 *                  `parseData` is a descendant of its render block.
 */
export const getCursorRangeByParseData = (
    parseData?: RootRenderData | ParentRenderData | RenderData,
    root?: RootRenderData | ParentRenderData,
): CursorRange | null => {
    if (!parseData) return null;

    // Resolve the render block: self → ancestor (via root) → descendant.
    let renderBlock: ParentRenderData | RenderData | null = null;
    if (parseData.htmlProps_[DATA_RENDER_ID]) {
        renderBlock = parseData;
    } else if (root) {
        renderBlock = findRenderBlockFor(root, parseData);
    }
    if (!renderBlock) {
        renderBlock = firstRenderDescendant(parseData);
    }
    if (!renderBlock) return null;

    const uuid = renderBlock.uuid_;

    // Offset span of `parseData` within the resolved block.
    let start: number;
    let end: number;
    if (
        renderBlock === parseData ||
        renderBlock.uuid_ === parseData.uuid_
    ) {
        // `parseData` IS the block → whole block.
        start = 0;
        end = blockTextLength(renderBlock);
    } else {
        const before = textOffsetWithin(renderBlock, parseData);
        if (before === null) {
            // Block sits *inside* `parseData` (descendant fallback): the span of
            // `parseData` within it isn't meaningful — select the whole block.
            start = 0;
            end = blockTextLength(renderBlock);
        } else {
            start = before;
            end = before + blockTextLength(parseData);
        }
    }

    return {
        startCursorInfo: { uuid, offset: start },
        endCursorInfo: { uuid, offset: end },
    };
};
