import { AnyNode } from "../../type";
import { walkTextLeaves } from "./walkTextLeaves";

export const blockTextLength = (block: AnyNode): number => {
    let total = 0;
    walkTextLeaves(block, (leaf) => {
        total += leaf.text_.length;
        return false;
    });
    return total;
};