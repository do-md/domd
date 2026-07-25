/**
 * Y events -> RenderDataOp translator: the core of the realtime inbound path.
 *
 * Key fact: Y.Doc's observeDeep events are already precise deltas, and their
 * vocabulary maps one-to-one onto core's RenderDataOp (the op vocabulary was
 * designed to align with Y semantics) — so the inbound direction is simply
 * the mirror of the outbound one (applyOpToY), with no diffing needed:
 *
 * - YArrayEvent (a node's children array) -> delta{retain/insert/delete}
 *   unrolled with a cursor into insert/delete ops (parent = uuid of the map
 *   hosting the array; index semantics = applied in order against the array
 *   being rewritten, matching core's applyRenderDataOpsToDraft).
 * - YMapEvent (a node's fields) -> keysChanged expanded key-by-key into set
 *   ops; a change of the uuid key can only happen at the root (whole-tree
 *   replacement) -> promoted to replaceRoot.
 *
 * Yjs never emits separate events for the *interior* of a freshly inserted
 * subtree (the insert delta carries the full content), so translating each
 * event independently is complete.
 */
import * as Y from "yjs";
import type { RenderDataOp, SerializedRenderData } from "../crdt-sync/types";

const SET_KEYS = new Set([
    "type",
    "text",
    "props",
    "mdSymbols",
    "tagName",
    "isAutoFill",
    "children",
]);

export const translateYEvents = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
): RenderDataOp[] => {
    const ops: RenderDataOp[] = [];
    for (const event of events) {
        const target = event.target;

        if (target instanceof Y.Array) {
            // children array event: the host node is the array's parent Y.Map.
            const hostMap = target.parent as Y.Map<unknown> | null;
            const parentUuid = hostMap?.get("uuid") as string | undefined;
            if (!parentUuid) continue;
            let cursor = 0;
            for (const d of event.delta) {
                if (d.retain) {
                    cursor += d.retain;
                    continue;
                }
                if (d.insert) {
                    for (const item of d.insert as Y.Map<unknown>[]) {
                        ops.push({
                            op: "insert",
                            parent: parentUuid,
                            index: cursor,
                            node: item.toJSON() as SerializedRenderData,
                        });
                        cursor += 1;
                    }
                    continue;
                }
                if (d.delete) {
                    for (let k = 0; k < d.delete; k += 1) {
                        ops.push({
                            op: "delete",
                            parent: parentUuid,
                            index: cursor,
                        });
                    }
                }
            }
            continue;
        }

        if (target instanceof Y.Map) {
            const mapEvent = event as Y.YMapEvent<unknown>;
            // A uuid change means whole-tree root replacement (non-root uuids are immutable).
            if (mapEvent.keysChanged.has("uuid")) {
                ops.push({
                    op: "replaceRoot",
                    node: target.toJSON() as SerializedRenderData,
                });
                continue;
            }
            const uuid = target.get("uuid") as string | undefined;
            if (!uuid) continue;
            for (const key of mapEvent.keysChanged) {
                if (!SET_KEYS.has(key)) continue;
                const value = target.get(key);
                ops.push({
                    op: "set",
                    uuid,
                    key: key as never,
                    value:
                        value instanceof Y.AbstractType
                            ? value.toJSON()
                            : value,
                });
            }
        }
    }
    return ops;
};
