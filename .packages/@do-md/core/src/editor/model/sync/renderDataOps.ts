import { MarkdownType } from "../../type/enum";
import { ParentRenderData, RenderData } from "../../type";

/**
 * The RenderData sync seam (CRDT-ready, platform-agnostic, with no dependency
 * on any CRDT library).
 *
 * Background: the published build mangles every `_`-suffixed internal field, so
 * at runtime the renderData tree the host application receives has obfuscated
 * field names and cannot be walked / diffed / persisted on its own. The kernel
 * therefore provides three things here, all in terms of **stable public keys**
 * (type/uuid/text/children/...):
 *
 * 1. serialize / deserialize — internal tree ↔ stable JSON (persistable, stable
 *    across versions).
 * 2. diffRenderData — a reference-pruned tree diff riding on immer's structural
 *    sharing, emitting a minimal op stream (insert/delete/set, addressed by
 *    uuid). Together with the span-preserving merge (mergeInlineBlock), the ops
 *    that typing produces naturally land at span granularity.
 *    Note: this does not consume immer patches — for a splice in the middle of
 *    an array immer emits a noisy "replace every following index" patch set,
 *    whereas a reference diff is immune (reference == identity).
 * 3. The host application (a Yjs plugin, say) maps the op stream onto CRDT
 *    structures:
 *    - insert/delete address by (parent uuid, index) and map to Y.Array ops;
 *    - set addresses by uuid (the consumer maintains its own uuid → node
 *      registry);
 *    - an op array is one state change's transaction: apply it in order,
 *      atomically.
 */

export interface SerializedRenderData {
    type: string;
    uuid: string;
    mdSymbols: string[];
    props: Record<string, unknown>;
    tagName?: string;
    isAutoFill?: boolean;
    /** Text of a leaf node; mutually exclusive with children */
    text?: string;
    /** Children of a container node; mutually exclusive with text */
    children?: SerializedRenderData[];
}

export type RenderDataOp =
    | {
          op: "insert";
          /** uuid of the parent node */
          parent: string;
          /** Index within the parent's children (as seen while the ops are
           *  applied one after another, in order) */
          index: number;
          node: SerializedRenderData;
      }
    | { op: "delete"; parent: string; index: number }
    | {
          op: "set";
          uuid: string;
          key: "type" | "text" | "props" | "mdSymbols" | "tagName" | "isAutoFill" | "children";
          value: unknown;
      }
    | { op: "replaceRoot"; node: SerializedRenderData };

type AnyNode = RenderData | ParentRenderData;

const cloneProps = (props: object | undefined): Record<string, unknown> =>
    props ? (JSON.parse(JSON.stringify(props)) as Record<string, unknown>) : {};

export const serializeRenderData = (node: AnyNode): SerializedRenderData => {
    const json: SerializedRenderData = {
        type: node.htmlType_ as string,
        uuid: node.uuid_,
        mdSymbols: [...node.mdSymbols_],
        props: cloneProps(node.htmlProps_),
    };
    if (node.tagName_ !== undefined) json.tagName = node.tagName_;
    if (node.isAutoFill_ !== undefined) json.isAutoFill = node.isAutoFill_;
    if (node.children_) {
        json.children = node.children_.map(serializeRenderData);
    } else {
        json.text = node.text_ || "";
    }
    return json;
};

export const deserializeRenderData = (
    json: SerializedRenderData,
): AnyNode => {
    const base = {
        htmlType_: json.type as MarkdownType,
        uuid_: json.uuid,
        mdSymbols_: [...json.mdSymbols],
        htmlProps_: cloneProps(json.props) as AnyNode["htmlProps_"],
        ...(json.tagName !== undefined ? { tagName_: json.tagName } : {}),
        ...(json.isAutoFill !== undefined
            ? { isAutoFill_: json.isAutoFill }
            : {}),
    };
    if (json.children) {
        return {
            ...base,
            children_: json.children.map(deserializeRenderData),
        } as ParentRenderData;
    }
    return { ...base, text_: json.text || "" } as RenderData;
};

/**
 * Reference-pruned tree diff: when prev/next come from the same immer evolution
 * chain, untouched subtrees are reference-equal, so this costs O(size of the
 * change). A changed root uuid (a whole-tree replacement, e.g. resetMD or
 * loading a document) degrades to a single replaceRoot op.
 */
export const diffRenderData = (
    prev: AnyNode,
    next: AnyNode,
): RenderDataOp[] => {
    const ops: RenderDataOp[] = [];
    if (prev === next) return ops;
    if (prev.uuid_ !== next.uuid_) {
        ops.push({ op: "replaceRoot", node: serializeRenderData(next) });
        return ops;
    }
    diffNode(prev, next, ops);
    return ops;
};

/** Field-level + children diff for a prev/next pair that shares a uuid */
const diffNode = (prev: AnyNode, next: AnyNode, ops: RenderDataOp[]) => {
    if (prev === next) return;
    const uuid = next.uuid_;
    if (prev.htmlType_ !== next.htmlType_) {
        ops.push({ op: "set", uuid, key: "type", value: next.htmlType_ });
    }
    if (prev.tagName_ !== next.tagName_) {
        ops.push({ op: "set", uuid, key: "tagName", value: next.tagName_ });
    }
    if (prev.isAutoFill_ !== next.isAutoFill_) {
        ops.push({
            op: "set",
            uuid,
            key: "isAutoFill",
            value: next.isAutoFill_,
        });
    }
    if (prev.htmlProps_ !== next.htmlProps_) {
        ops.push({
            op: "set",
            uuid,
            key: "props",
            value: cloneProps(next.htmlProps_),
        });
    }
    if (prev.mdSymbols_ !== next.mdSymbols_) {
        ops.push({
            op: "set",
            uuid,
            key: "mdSymbols",
            value: [...next.mdSymbols_],
        });
    }

    if (prev.children_ && next.children_) {
        if (prev.children_ !== next.children_) {
            diffChildren(prev.children_, next.children_, uuid, ops);
        }
    } else if (prev.children_ || next.children_) {
        // Leaf ↔ container shape switch (same uuid, rare): replace the whole
        // children field
        ops.push({
            op: "set",
            uuid,
            key: "children",
            value: next.children_
                ? next.children_.map(serializeRenderData)
                : null,
        });
        if (!next.children_) {
            ops.push({ op: "set", uuid, key: "text", value: next.text_ || "" });
        }
    } else if ((prev.text_ || "") !== (next.text_ || "")) {
        ops.push({ op: "set", uuid, key: "text", value: next.text_ || "" });
    }
};

/**
 * Children-array diff: an identity prefix/suffix (reference equality) plus
 * greedy uuid pairing across the middle. Spans are immutable atoms (only
 * created and deleted), so reference == identity and no LCS is needed.
 * Index semantics: each op applies in turn to the array as it is being
 * rewritten (the same semantics as Y.Array).
 */
const diffChildren = (
    prevArr: AnyNode[],
    nextArr: AnyNode[],
    parentUuid: string,
    ops: RenderDataOp[],
) => {
    let start = 0;
    const minLen = Math.min(prevArr.length, nextArr.length);
    while (start < minLen && prevArr[start] === nextArr[start]) start += 1;
    let endP = prevArr.length;
    let endN = nextArr.length;
    while (
        endP > start &&
        endN > start &&
        prevArr[endP - 1] === nextArr[endN - 1]
    ) {
        endP -= 1;
        endN -= 1;
    }

    const prevMidIds = new Set<string>();
    for (let k = start; k < endP; k += 1) prevMidIds.add(prevArr[k].uuid_);
    const nextMidIds = new Set<string>();
    for (let k = start; k < endN; k += 1) nextMidIds.add(nextArr[k].uuid_);

    let i = start;
    let j = start;
    let cursor = start;
    while (i < endP || j < endN) {
        const p = i < endP ? prevArr[i] : null;
        const n = j < endN ? nextArr[j] : null;
        if (p && n && p.uuid_ === n.uuid_) {
            diffNode(p, n, ops);
            i += 1;
            j += 1;
            cursor += 1;
            continue;
        }
        if (p && (!n || !nextMidIds.has(p.uuid_))) {
            ops.push({ op: "delete", parent: parentUuid, index: cursor });
            i += 1;
            continue;
        }
        if (n && (!p || !prevMidIds.has(n.uuid_))) {
            ops.push({
                op: "insert",
                parent: parentUuid,
                index: cursor,
                node: serializeRenderData(n),
            });
            j += 1;
            cursor += 1;
            continue;
        }
        // Present in the other side's middle in both directions (a reorder):
        // delete on the prev side first; the later nextArr entries come back
        // as inserts.
        ops.push({ op: "delete", parent: parentUuid, index: cursor });
        i += 1;
    }
};

// ---------------------------------------------------------------------------
// Inbound: op-level replay (the realtime-collaboration hot path)
// ---------------------------------------------------------------------------

/** DFS lookup by uuid inside the draft tree (the v1 implementation; for large,
 *  heavily edited documents this could become an index maintained incrementally
 *  from the op stream) */
const findNodeByUuid = (node: AnyNode, uuid: string): AnyNode | null => {
    if (node.uuid_ === uuid) return node;
    if (!node.children_) return null;
    for (const child of node.children_) {
        const found = findNodeByUuid(child, uuid);
        if (found) return found;
    }
    return null;
};

/**
 * Applies a remote op stream to an immer draft in order (the exact inverse of
 * what diffRenderData emits, and the same semantics as the plugin-side Y
 * mirror's applyOp). immer only allocates new objects along the path from the
 * root to each touched node → every other reference survives → React memo hits
 * across the board → rendering costs O(size of the change).
 *
 * Fault tolerance: an op whose target uuid/index is missing is skipped
 * silently — a single dropped op is caught upstream by dual-source-of-truth
 * validation / full reconciliation, and the hot path never throws.
 */
export const applyRenderDataOpsToDraft = (
    rootHolder: { renderData_: ParentRenderData },
    ops: RenderDataOp[],
): void => {
    for (const op of ops) {
        if (op.op === "replaceRoot") {
            rootHolder.renderData_ = deserializeRenderData(
                op.node,
            ) as ParentRenderData;
            continue;
        }
        if (op.op === "insert") {
            const parent = findNodeByUuid(rootHolder.renderData_, op.parent);
            if (!parent?.children_) continue;
            parent.children_.splice(
                Math.min(op.index, parent.children_.length),
                0,
                deserializeRenderData(op.node),
            );
            continue;
        }
        if (op.op === "delete") {
            const parent = findNodeByUuid(rootHolder.renderData_, op.parent);
            if (!parent?.children_) continue;
            if (op.index >= parent.children_.length) continue;
            parent.children_.splice(op.index, 1);
            continue;
        }
        // set
        const target = findNodeByUuid(rootHolder.renderData_, op.uuid) as
            | (AnyNode & { [key: string]: unknown })
            | null;
        if (!target) continue;
        switch (op.key) {
            case "type":
                target.htmlType_ = op.value as AnyNode["htmlType_"];
                break;
            case "text":
                target.text_ = (op.value as string) || "";
                delete target.children_;
                break;
            case "props":
                target.htmlProps_ = cloneProps(
                    op.value as object,
                ) as AnyNode["htmlProps_"];
                break;
            case "mdSymbols":
                target.mdSymbols_ = [...(op.value as string[])];
                break;
            case "tagName":
                if (op.value === undefined || op.value === null) {
                    delete target.tagName_;
                } else {
                    target.tagName_ = op.value as string;
                }
                break;
            case "isAutoFill":
                if (op.value === undefined || op.value === null) {
                    delete target.isAutoFill_;
                } else {
                    target.isAutoFill_ = op.value as boolean;
                }
                break;
            case "children":
                if (op.value === null || op.value === undefined) {
                    delete target.children_;
                } else {
                    target.children_ = (
                        op.value as SerializedRenderData[]
                    ).map(deserializeRenderData) as ParentRenderData["children_"];
                    delete target.text_;
                }
                break;
            default:
                break;
        }
    }
};

/**
 * A snapshot of the local cursor (the stable public shape for outbound
 * awareness).
 * spanUuid/spanOffset are an optional span-level anchor (the smallest text leaf
 * the cursor sits in): a consumer resolves them through
 * store.resolveCursorPosition into block-level coordinates in the current tree
 * before positioning in the DOM, which keeps the cursor from drifting while the
 * same block is being edited. Older consumers that do not know these two fields
 * can just keep using uuid+offset.
 */
export interface CursorSnapshot {
    start: {
        uuid: string;
        offset: number;
        spanUuid?: string;
        spanOffset?: number;
    } | null;
    end: {
        uuid: string;
        offset: number;
        spanUuid?: string;
        spanOffset?: number;
    } | null;
}
