import { DATA_VIEW_ONLY } from "../../../data-parse/constant";

/** True when the node is a view-only decoration element (or lives outside
 *  the text pipeline for any reason). Whole subtrees under such elements are
 *  invisible to text extraction and cursor offset math. */
export const isViewOnlyDom = (node: Node): boolean =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).hasAttribute(DATA_VIEW_ONLY);