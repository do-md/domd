import { DATA_FILLER_BR } from "../../../data-parse/constant";
import { getClosestRenderDom } from "./getClosestRenderDom";
import { isInsideInactiveSymbol } from "./isInsideInactiveSymbol";
import { isViewOnlyDom } from "./isViewOnlyDom";

export const getDomByCursor = (editDom: HTMLElement, cursor: number) => {
    let checked = 0;
    let nodeOffset = 0;

    const findDom = (node: Node): Node | undefined => {
        for (const nodeChild of node.childNodes) {
            // View-only decorations occupy DOM but no model text: skip the
            // whole subtree so model offsets keep addressing real content.
            if (isViewOnlyDom(nodeChild)) continue;
            if (nodeChild.childNodes.length) {
                const target: Node | undefined = findDom(nodeChild);
                if (target) return target;
            } else {
                const text = nodeChild.textContent;
                checked += text?.length || 0;
                if (checked >= cursor) {
                    nodeOffset = cursor + (text?.length || 0) - checked;
                    return nodeChild;
                }
            }
        }
    };
    const found = findDom(editDom);

    // Trailing-line normalization: when the cursor lands at the end of a text node
    // that ends with "\n" and the block's trailing filler <br> follows immediately,
    // write the coordinate back as (br, 0) instead. Setting it directly at
    // (text, end) makes Chrome paint the caret at the end of the previous line (the
    // affinity quirk of a trailing \n having no line box; experimental data in
    // reference/zwsp-to-trailing-br-plan.md). (br, 0) is structurally identical to
    // what the generic walk returns for an EmptyP's p>br (verified in production),
    // and br.parentNode is still the enclosing block, so the caller's
    // node.parentNode → getClosestRenderDom climb is unaffected.
    if (
        found &&
        found.nodeType === Node.TEXT_NODE &&
        nodeOffset === (found.textContent?.length || 0) &&
        found.textContent?.endsWith("\n")
    ) {
        let cur: Node = found;
        while (cur !== editDom && cur.parentNode && !cur.nextSibling) {
            cur = cur.parentNode;
        }
        const next = cur === editDom ? null : cur.nextSibling;
        if (
            next &&
            next.nodeType === Node.ELEMENT_NODE &&
            (next as Element).tagName === "BR" &&
            (next as Element).hasAttribute(DATA_FILLER_BR)
        ) {
            return { node: next, offset: 0 };
        }
    }

    // Hidden-symbol snapping: when the landing spot sits inside a syntax symbol
    // that is not revealed (data-active="false", display:none — always hidden in
    // rich mode, and the same whenever reveal misses in markdown mode), the caret
    // has no visual position and Chrome normalizes it somewhere unpredictable (the
    // caret jump seen in rich mode the instant a construct closes). Snap to the next
    // visible text position in document order (the same visual point, and
    // Range.toString() counts are unchanged — display:none text still counts, so the
    // 1:1 model↔DOM offset invariant holds); if there is no visible position
    // forward, fall back to the end of the previous visible position.
    if (found && isInsideInactiveSymbol(found, editDom)) {
        // Snapping never crosses a block: collect candidate leaves only inside the
        // render block that owns `found` (editDom may be the whole-document root —
        // that is how checkAutofill_ / getRenderparent_ call in — where walking the
        // entire tree is both wasteful and liable to snap into the wrong block).
        const scope =
            (found.parentElement && getClosestRenderDom(found.parentElement)) ||
            editDom;
        const leaves: Node[] = [];
        const collect = (node: Node) => {
            for (const child of node.childNodes) {
                if (isViewOnlyDom(child)) continue;
                if (child.childNodes.length) collect(child);
                else leaves.push(child);
            }
        };
        collect(scope);
        const isVisibleCaretHost = (n: Node): boolean => {
            if (isInsideInactiveSymbol(n, scope)) return false;
            if (n.nodeType === Node.TEXT_NODE) return true;
            return (
                n.nodeType === Node.ELEMENT_NODE &&
                (n as Element).tagName === "BR"
            );
        };
        const at = leaves.indexOf(found);
        for (let i = at + 1; i < leaves.length; i++) {
            if (isVisibleCaretHost(leaves[i])) {
                return { node: leaves[i], offset: 0 };
            }
        }
        for (let i = at - 1; i >= 0; i--) {
            if (isVisibleCaretHost(leaves[i])) {
                return {
                    node: leaves[i],
                    offset: leaves[i].textContent?.length || 0,
                };
            }
        }
        // No visible landing spot anywhere in the block (e.g. an empty heading
        // `# `): keep the original coordinate and let the browser normalize it.
    }

    return {
        node: found,
        offset: nodeOffset,
    };
};
