export function getOffsetTop(element: HTMLElement, target: HTMLElement) {
    function getOffset(element: HTMLElement) {
        const offset = {
            top: 0,
            left: 0,
        };
        while (element) {
            offset.top += element.offsetTop;
            offset.left += element.offsetLeft;
            element = element.offsetParent as HTMLElement;
        }
        return offset;
    }

    function getCommonAncestor(a: HTMLElement, b: HTMLElement) {
        const parents = function (node: HTMLElement) {
            const nodes = [node];
            for (; node; node = node.parentNode as HTMLElement) {
                nodes.unshift(node);
            }
            return nodes;
        };
        const nodesA = parents(a);
        const nodesB = parents(b);

        if (nodesA[0] !== nodesB[0]) throw "No common ancestor!";

        for (let i = 0; i < nodesA.length; i += 1) {
            if (nodesA[i] !== nodesB[i]) return nodesA[i - 1];
        }
    }

    const commonAncestor = getCommonAncestor(element, target);
    const elementOffset = getOffset(element);
    const targetOffset = getOffset(target);
    const commonAncestorOffset = getOffset(commonAncestor as HTMLElement);

    return elementOffset.top - targetOffset.top + commonAncestorOffset.top;
}