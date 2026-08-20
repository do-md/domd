import { AnyNode, TextLeaf } from "../../type";

/**
 * Pre-order walk of the text leaves in a block's subtree (`typeof text_ ===
 * "string"`, in the same coordinate space as blockTextLength / getNodeInfo:
 * raw `text_` lengths, with text-less nodes such as checkboxes contributing
 * 0). Return true from `cb` to stop early.
 */
export const walkTextLeaves = (
    block: AnyNode,
    cb: (leaf: TextLeaf, prefix: number) => boolean,
): void => {
    let acc = 0;
    const visit = (node: AnyNode): boolean => {
        if (typeof node.text_ === "string") {
            if (cb(node as TextLeaf, acc)) return true;
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
    visit(block);
};