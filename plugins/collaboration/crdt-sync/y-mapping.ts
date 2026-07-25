/**
 * Shared mapping layer between SerializedRenderData and the Y structure.
 * Used by both crdt-sync (offline merge / persistence) and realtime-sync
 * (live collaboration).
 *
 * node = Y.Map{type,uuid,text?,mdSymbols,props,tagName?,isAutoFill?,children?}
 * children = Y.Array<Y.Map>; props/mdSymbols are whole-value LWW as plain JSON.
 */
import * as Y from "yjs";
import type { RenderDataOp, SerializedRenderData } from "./types";

/** Name of the top-level Y.Map that carries the document tree in the doc. */
export const ROOT_KEY = "domdRenderData";

// ---------------------------------------------------------------------------
// base64 <-> Uint8Array (chunked, to avoid blowing the stack on large docs).
// ---------------------------------------------------------------------------

export const uint8ToBase64 = (bytes: Uint8Array): string => {
    const CHUNK_SIZE = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
        binary += String.fromCharCode.apply(
            null,
            chunk as unknown as number[],
        );
    }
    return btoa(binary);
};

export const base64ToUint8 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

// ---------------------------------------------------------------------------
// Node construction (SerializedRenderData <-> Y structure).
// ---------------------------------------------------------------------------

export const setScalarFields = (
    yNode: Y.Map<unknown>,
    json: SerializedRenderData,
) => {
    yNode.set("type", json.type);
    yNode.set("uuid", json.uuid);
    yNode.set("mdSymbols", [...json.mdSymbols]);
    yNode.set("props", JSON.parse(JSON.stringify(json.props)));
    if (json.tagName !== undefined) yNode.set("tagName", json.tagName);
    else yNode.delete("tagName");
    if (json.isAutoFill !== undefined) yNode.set("isAutoFill", json.isAutoFill);
    else yNode.delete("isAutoFill");
};

export const toYNode = (json: SerializedRenderData): Y.Map<unknown> => {
    const yNode = new Y.Map<unknown>();
    setScalarFields(yNode, json);
    if (json.children) {
        const yChildren = new Y.Array<Y.Map<unknown>>();
        yChildren.insert(0, json.children.map(toYNode));
        yNode.set("children", yChildren);
    } else {
        yNode.set("text", json.text || "");
    }
    return yNode;
};

export const yNodeToJSON = (yNode: Y.Map<unknown>): SerializedRenderData =>
    yNode.toJSON() as SerializedRenderData;

// ---------------------------------------------------------------------------
// uuid -> Y.Map registry.
// ---------------------------------------------------------------------------

export type Registry = Map<string, Y.Map<unknown>>;

export const registerSubtree = (
    yNode: Y.Map<unknown>,
    registry: Registry,
) => {
    registry.set(yNode.get("uuid") as string, yNode);
    const children = yNode.get("children") as
        | Y.Array<Y.Map<unknown>>
        | undefined;
    children?.forEach((child) => registerSubtree(child, registry));
};

export const unregisterSubtree = (
    yNode: Y.Map<unknown>,
    registry: Registry,
) => {
    registry.delete(yNode.get("uuid") as string);
    const children = yNode.get("children") as
        | Y.Array<Y.Map<unknown>>
        | undefined;
    children?.forEach((child) => unregisterSubtree(child, registry));
};

// ---------------------------------------------------------------------------
// Op application (strictly aligned with core's diffRenderData semantics).
// ---------------------------------------------------------------------------

export const applyOpToY = (
    rootNode: Y.Map<unknown>,
    op: RenderDataOp,
    registry: Registry,
): void => {
    if (op.op === "replaceRoot") {
        unregisterSubtree(rootNode, registry);
        // The root is doc.getMap; it cannot be swapped wholesale — clear it, then rebuild its fields from the new node.
        for (const key of [...rootNode.keys()]) rootNode.delete(key);
        setScalarFields(rootNode, op.node);
        if (op.node.children) {
            const yChildren = new Y.Array<Y.Map<unknown>>();
            yChildren.insert(0, op.node.children.map(toYNode));
            rootNode.set("children", yChildren);
        } else {
            rootNode.set("text", op.node.text || "");
        }
        registerSubtree(rootNode, registry);
        return;
    }
    if (op.op === "insert") {
        const parent = registry.get(op.parent);
        if (!parent) return;
        let children = parent.get("children") as
            | Y.Array<Y.Map<unknown>>
            | undefined;
        if (!children) {
            children = new Y.Array<Y.Map<unknown>>();
            parent.set("children", children);
        }
        const yNode = toYNode(op.node);
        children.insert(Math.min(op.index, children.length), [yNode]);
        registerSubtree(yNode, registry);
        return;
    }
    if (op.op === "delete") {
        const parent = registry.get(op.parent);
        const children = parent?.get("children") as
            | Y.Array<Y.Map<unknown>>
            | undefined;
        if (!children || op.index >= children.length) return;
        unregisterSubtree(children.get(op.index), registry);
        children.delete(op.index, 1);
        return;
    }
    // set
    const target = registry.get(op.uuid);
    if (!target) return;
    switch (op.key) {
        case "children": {
            const prevChildren = target.get("children") as
                | Y.Array<Y.Map<unknown>>
                | undefined;
            prevChildren?.forEach((c) => unregisterSubtree(c, registry));
            if (op.value === null) {
                target.delete("children");
            } else {
                const yChildren = new Y.Array<Y.Map<unknown>>();
                yChildren.insert(
                    0,
                    (op.value as SerializedRenderData[]).map(toYNode),
                );
                target.set("children", yChildren);
                target.delete("text");
                (target.get("children") as Y.Array<Y.Map<unknown>>).forEach(
                    (c) => registerSubtree(c, registry),
                );
            }
            return;
        }
        case "text":
            target.set("text", op.value as string);
            target.delete("children");
            return;
        case "type":
            target.set("type", op.value as string);
            return;
        case "props":
            target.set("props", JSON.parse(JSON.stringify(op.value)));
            return;
        case "mdSymbols":
            target.set("mdSymbols", op.value as string[]);
            return;
        case "tagName":
            if (op.value === undefined) target.delete("tagName");
            else target.set("tagName", op.value as string);
            return;
        case "isAutoFill":
            if (op.value === undefined) target.delete("isAutoFill");
            else target.set("isAutoFill", op.value as boolean);
            return;
        default:
            return;
    }
};
