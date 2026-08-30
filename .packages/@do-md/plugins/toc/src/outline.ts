/**
 * Pure outline extraction over the kernel's serialized render-data tree —
 * no DOM, no React, no kernel import. Everything here is typed structurally
 * against the STABLE public keys (`type`/`uuid`/`text`/`children`) that
 * `getRenderDataSnapshot()` returns and `subscribeRenderDataOps()` ops carry,
 * so the package compiles against any kernel providing that contract.
 *
 * Design decisions (see the mainstream-outline survey in the app repo):
 *
 * - THE DATA SHAPE IS A FLAT LIST with the REAL heading level (1-6, never
 *   normalized) plus a computed render `depth` — the Tiptap dual-field
 *   posture. Tree-ing is a render concern; a flat list keeps every consumer
 *   (panel, breadcrumb, sticky header) trivial.
 * - `depth` uses the nearest-shallower-predecessor rule (Docusaurus'
 *   treeifyTOC, VS Code's section ranges): a skipped level (h2 → h4) nests
 *   one step deeper, never two, and a document that starts below h1 still
 *   yields depth 0 for its first heading. No placeholder nodes.
 * - ONLY TOP-LEVEL HEADINGS COUNT. A heading inside a blockquote is quoted
 *   content, not document structure (Typora/pandoc semantics).
 * - ENTRY TEXT IS PLAIN TEXT (the VS Code / Lexical / Tiptap consensus):
 *   markdown markers — `MdSymbol` nodes: `## `, `**`, the whole `[..](..)`
 *   link/image syntax — are dropped, content leaves (bold/code/link text)
 *   are kept.
 * - Identity is the block uuid (also the DOM anchor `data-render-id`), so
 *   duplicate / renamed titles need no slug machinery at all.
 */

/** Structural slice of the kernel's SerializedRenderData. */
export interface OutlineNode {
    type: string;
    uuid: string;
    /** Text of a leaf node; mutually exclusive with children. */
    text?: string;
    /** Children of a container node; mutually exclusive with text. */
    children?: OutlineNode[];
}

/** Structural slice of the kernel's RenderDataOp union (loose on purpose:
 *  unknown op kinds must fail toward a rescan, never toward staleness). */
export interface OutlineOp {
    op: string;
    parent?: string;
    uuid?: string;
    key?: string;
    node?: OutlineNode;
    value?: unknown;
}

export interface TocHeading {
    /** Block uuid — also the DOM anchor: `[data-render-id="<uuid>"]`. */
    uuid: string;
    /** Real heading level, 1-6 (H1..H6). Never normalized. */
    level: number;
    /** Render depth, 0-based, by the nearest-shallower-predecessor rule. */
    depth: number;
    /** Plain title text with every markdown marker stripped. */
    text: string;
}

/** The scan product: the outline plus the uuid indexes `opsAffectOutline`
 *  consults to decide whether an op batch can possibly change the outline. */
export interface OutlineIndex {
    headings: TocHeading[];
    rootUuid: string;
    /** uuids of every top-level block (headings or not). */
    topLevel: Set<string>;
    /** uuids of every heading and all of its descendants. */
    headingSubtree: Set<string>;
}

const HEADING_TYPE = /^H[1-6]$/;
const MD_SYMBOL_TYPE = "MdSymbol";
/** The kernel's private cursor-protocol character (U+E000). It never belongs
 *  in the tree, but if one ever leaks it must not surface in a panel. */
const CURSOR_MARKER = "\uE000";

export const isHeadingType = (type: string): boolean =>
    HEADING_TYPE.test(type);

/** Plain text of a heading subtree: concatenated leaf text, skipping every
 *  MdSymbol node (block marker, emphasis fences, link/image syntax). */
export const headingText = (heading: OutlineNode): string => {
    let out = "";
    const walk = (node: OutlineNode) => {
        if (node.type === MD_SYMBOL_TYPE) return;
        if (node.children) {
            for (const child of node.children) walk(child);
        } else if (node.text) {
            out += node.text;
        }
    };
    walk(heading);
    return out.split(CURSOR_MARKER).join("").replace(/\s+/g, " ").trim();
};

const collectSubtreeUuids = (node: OutlineNode, into: Set<string>) => {
    into.add(node.uuid);
    if (node.children) {
        for (const child of node.children) collectSubtreeUuids(child, into);
    }
};

/** One full scan of the snapshot. O(top-level count + heading subtree
 *  sizes) on top of the snapshot itself. */
export const buildOutline = (root: OutlineNode): OutlineIndex => {
    const headings: TocHeading[] = [];
    const topLevel = new Set<string>();
    const headingSubtree = new Set<string>();
    // Nearest-shallower-predecessor depth: pop levels >= the current one;
    // what remains on the stack are this heading's ancestors.
    const levelStack: number[] = [];
    for (const block of root.children ?? []) {
        topLevel.add(block.uuid);
        if (!HEADING_TYPE.test(block.type)) continue;
        const level = Number(block.type.slice(1));
        while (
            levelStack.length > 0 &&
            levelStack[levelStack.length - 1] >= level
        ) {
            levelStack.pop();
        }
        headings.push({
            uuid: block.uuid,
            level,
            depth: levelStack.length,
            text: headingText(block),
        });
        levelStack.push(level);
        collectSubtreeUuids(block, headingSubtree);
    }
    return { headings, rootUuid: root.uuid, topLevel, headingSubtree };
};

/** Value equality of two outlines (`depth` is derived from the level
 *  sequence, so uuid/level/text equality implies depth equality). Used to
 *  skip store updates when a rescan reproduces the same outline. */
export const outlineEquals = (a: TocHeading[], b: TocHeading[]): boolean => {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (
            a[i].uuid !== b[i].uuid ||
            a[i].level !== b[i].level ||
            a[i].text !== b[i].text
        ) {
            return false;
        }
    }
    return true;
};

const nodeContainsHeading = (node: OutlineNode): boolean => {
    if (HEADING_TYPE.test(node.type)) return true;
    if (!node.children) return false;
    return node.children.some(nodeContainsHeading);
};

/**
 * Cheap relevance filter over an op batch: `false` means the batch provably
 * cannot change the outline (the common case — typing inside a paragraph),
 * `true` means rescan. Anything unrecognized fails toward `true`.
 *
 * Rules against the index from the LAST scan:
 * - replaceRoot → rescan (document load / undo across a reset).
 * - insert/delete at the root, or anywhere inside a heading subtree →
 *   rescan; an inserted subtree carrying a heading anywhere → rescan.
 * - set on any uuid inside a heading subtree (title edits arrive as text
 *   sets on descendant spans) → rescan; a `type` set on a top-level block
 *   (paragraph ↔ heading conversion, level change) → rescan.
 */
export const opsAffectOutline = (
    ops: OutlineOp[],
    index: OutlineIndex,
): boolean => {
    for (const op of ops) {
        switch (op.op) {
            case "replaceRoot":
                return true;
            case "insert": {
                if (op.parent === undefined) return true;
                if (
                    op.parent === index.rootUuid ||
                    index.headingSubtree.has(op.parent)
                ) {
                    return true;
                }
                if (op.node && nodeContainsHeading(op.node)) return true;
                break;
            }
            case "delete": {
                if (op.parent === undefined) return true;
                if (
                    op.parent === index.rootUuid ||
                    index.headingSubtree.has(op.parent)
                ) {
                    return true;
                }
                break;
            }
            case "set": {
                if (op.uuid === undefined) return true;
                if (index.headingSubtree.has(op.uuid)) return true;
                if (op.key === "type" && index.topLevel.has(op.uuid)) {
                    return true;
                }
                // A `children` set can swap a whole subtree in; if the new
                // value carries a heading it matters even outside known sets.
                if (op.key === "children" && Array.isArray(op.value)) {
                    const children = op.value as OutlineNode[];
                    if (children.some(nodeContainsHeading)) return true;
                }
                break;
            }
            default:
                return true;
        }
    }
    return false;
};
