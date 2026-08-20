/** True when the node sits inside a syntax-symbol element that is currently
 *  NOT revealed (`data-active="false"` → display:none). Such positions have
 *  no visual caret location. Climbs at most to `stopAt`. */
export const isInsideInactiveSymbol = (node: Node, stopAt: Node): boolean => {
    let cur: Node | null =
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (cur && cur !== stopAt) {
        if (
            cur.nodeType === Node.ELEMENT_NODE &&
            (cur as Element).getAttribute("data-active") === "false"
        ) {
            return true;
        }
        cur = cur.parentElement;
    }
    return false;
};