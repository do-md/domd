import { MarkdownType } from "../../type/enum";
import { ParentRenderData, RenderData } from "../../type";
import {
    collectChars,
    FlatChar,
    mergeInlineContainer,
} from "./mergeInlineBlock";
import {
    DATA_ATOMIC_RENDER_ID,
    DATA_RENDER_ID,
} from "../../../data-parse/constant";

/**
 * Structural (block-container) merge — the generic sibling of the char-level
 * mergeInlineContainer, and the single entry (mergeParsedBlock) the chain
 * calls for every block-level reparse.
 *
 * Motivation (collaborative authorship): replacing a whole block makes the
 * CRDT side record every span in the container (table / code block) as newly
 * created by whoever made this edit — untouched cells and code lines have to
 * keep their old references or their authorship is washed away.
 *
 * Two layers, one job each:
 * - Structural containers (Table/THead/TBody/TR/TD/TH/Pre/PreCode): a
 *   child-level two-ended equality scan (common prefix/suffix subtrees keep
 *   their original references) plus middle handling — equal counts recurse
 *   pairwise by position (a failed pairing replaces that slot wholesale),
 *   unequal counts splice (row / column / code-line insertions and deletions
 *   naturally land here).
 *   Why this layer cannot use a char diff: an empty child (an empty cell, an
 *   empty code line) contributes zero characters, so the char layer simply
 *   cannot see it being inserted or deleted.
 * - Inline containers (P, including the P inside a cell): when the recursion
 *   reaches one it delegates to mergeInlineContainer, and span-level reference
 *   reuse works exactly as before.
 *
 * uuid remapping: the merge keeps the old nodes and discards the new ones,
 * while the cursor uuid the parser reports points at a node of the new tree.
 * Every old/new pair that is kept records one new→old entry in `remap`, which
 * the caller uses to remap the cursor onto the tree that survived (the old
 * "special-case the first block's uuid" path for P/Header now goes through this
 * same table).
 *
 * Currently enabled for the Table family + the Pre family. Lists (li/Ul/Ol),
 * blockquotes and Detail still take the caller's whole-block splice fallback —
 * each has structure of its own (autofill, hidden rows), so add them to
 * STRUCTURAL_TYPES one at a time as they are verified (the mechanism itself is
 * generic; adding the type is all it takes to enable it).
 */

type Node = RenderData | ParentRenderData;

/** newUuid → oldUuid (where the merge kept an old node, the uuid mapping for
 *  the corresponding node of the fresh parse). */
export type UuidRemap = Map<string, string>;

const HEADER_TYPES = new Set<MarkdownType>([
    MarkdownType.H1,
    MarkdownType.H2,
    MarkdownType.H3,
    MarkdownType.H4,
    MarkdownType.H5,
    MarkdownType.H6,
]);

const STRUCTURAL_TYPES = new Set<MarkdownType>([
    MarkdownType.Table,
    MarkdownType.THead,
    MarkdownType.TBody,
    MarkdownType.TR,
    MarkdownType.TD,
    MarkdownType.TH,
    MarkdownType.Pre,
    MarkdownType.PreCode,
]);

/** htmlProps keys derived from per-parse uuids — excluded from equality
 *  (they are new nanoids every parse; including them = nothing ever equal). */
const UUID_DERIVED_PROPS = new Set<string>([
    DATA_RENDER_ID,
    DATA_ATOMIC_RENDER_ID,
]);

const propsEqual = (
    a: Record<string, unknown> | undefined,
    b: Record<string, unknown> | undefined,
): boolean => {
    const ka = Object.keys(a || {}).filter((k) => !UUID_DERIVED_PROPS.has(k));
    const kb = Object.keys(b || {}).filter((k) => !UUID_DERIVED_PROPS.has(k));
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
        const va = a![key];
        const vb = b?.[key];
        if (va === vb) continue;
        if (va && vb && typeof va === "object" && typeof vb === "object") {
            if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
            continue;
        }
        return false;
    }
    return true;
};

/** Span-partition-agnostic content equality for INLINE scopes: flatten both
 *  subtrees to (char, format-signature) streams and compare. Span
 *  partitioning is an edit-history artifact — a row typed on another client
 *  arrives with span boundaries a fresh local parse would never produce
 *  (spans are immutable atoms: created/deleted, never re-normalized), so a
 *  structural comparison over-invalidates content-identical nodes. The char
 *  stream still sees text, md symbols and inline formatting (signatures =
 *  ancestor type chains + href/src); only the partitioning is invisible —
 *  and zero-width leaves (Img/Br) serialize to "" so the round-trip cannot
 *  diverge either. */
const inlineContentEqual = (a: Node, b: Node): boolean => {
    const ca: FlatChar[] = [];
    const cb: FlatChar[] = [];
    collectChars(a, "", ca);
    collectChars(b, "", cb);
    if (ca.length !== cb.length) return false;
    for (let i = 0; i < ca.length; i++) {
        if (ca[i].c_ !== cb[i].c_ || ca[i].s_ !== cb[i].s_) return false;
    }
    return true;
};

/** Scan equality on (type, tagName, autofill flag, semantic props) + content:
 *  structural containers recurse child-pairwise (an empty child is a real
 *  child here — the reason this layer never uses char streams), inline
 *  scopes compare by content stream (span partitioning ignored).
 *  uuid_/mdSymbols_/domVersion_ excluded (per-parse randomness). */
const contentEqual = (a: Node, b: Node): boolean => {
    if (a.htmlType_ !== b.htmlType_) return false;
    if ((a.tagName_ ?? null) !== (b.tagName_ ?? null)) return false;
    if (!!a.isAutoFill_ !== !!b.isAutoFill_) return false;
    if (!propsEqual(a.htmlProps_, b.htmlProps_)) return false;
    if (STRUCTURAL_TYPES.has(a.htmlType_)) {
        const ac = a.children_ || [];
        const bc = b.children_ || [];
        if (ac.length !== bc.length) return false;
        for (let i = 0; i < ac.length; i++) {
            if (!contentEqual(ac[i], bc[i])) return false;
        }
        return true;
    }
    if (!a.children_ && !b.children_) {
        return (a.text_ ?? null) === (b.text_ ?? null);
    }
    return inlineContentEqual(a, b);
};

/** Both subtrees are content-equal (contentEqual) or pair-merged —
 *  record new→old for every node pair so cursor uuids resolve on the kept
 *  tree. */
const recordSubtreeRemap = (a: Node, b: Node, remap: UuidRemap) => {
    remap.set(b.uuid_, a.uuid_);
    const ac = a.children_ || [];
    const bc = b.children_ || [];
    const len = Math.min(ac.length, bc.length);
    for (let i = 0; i < len; i++) recordSubtreeRemap(ac[i], bc[i], remap);
};

/**
 * Where the dirty-DOM guard applies (the lesson of the "const =" duplication
 * incident):
 * - The Table family does not bump: the cursor's text lives in a cell's inner
 *   P, so smearing from speculative input is already covered by
 *   mergeInlineContainer's own bump, and the browser never writes the cursor's
 *   text directly between TR/TD. Not bumping buys something real — untouched
 *   rows and cells keep their shared references instead of remounting for
 *   nothing.
 * - PreCode must bump: its children are the direct home of the cursor's text
 *   (a flat list of token spans). While typing, the browser has already written
 *   the character into some span's DOM text node, and after the reparse that
 *   span often lands in the "model unchanged" kept region (the changed region
 *   is merely the neighbouring re-tokenized token) → React skips it on
 *   reference equality → the dirty character sticks around → the next
 *   getVisibleDomText reads it back twice → duplication that compounds with
 *   every keystroke. Same rule as in mergeInlineContainer: bump domVersion_ on
 *   the children flanking the changed region to force a remount that flushes
 *   the DOM.
 * domVersion_ is not serialized and takes no part in the sync diff → zero
 * impact on collaborative authorship.
 */
const bumpDomVersion = (node: Node | undefined) => {
    if (node) node.domVersion_ = (node.domVersion_ || 0) + 1;
};

/**
 * Generic recursive structural merge. Returns true = old node's identity
 * kept (its subtree updated in place with maximal reference reuse).
 */
const mergeStructuralNode = (
    oldNode: Node,
    newNode: Node,
    remap: UuidRemap,
): boolean => {
    if (oldNode.htmlType_ !== newNode.htmlType_) return false;

    // Inline container: char-level span-preserving merge (a cell's P descends
    // from here).
    if (oldNode.htmlType_ === MarkdownType.P) {
        if (!oldNode.children_ || !newNode.children_) return false;
        if (
            mergeInlineContainer(
                oldNode as ParentRenderData,
                newNode as ParentRenderData,
            )
        ) {
            remap.set(newNode.uuid_, oldNode.uuid_);
            return true;
        }
        return false;
    }

    if (!STRUCTURAL_TYPES.has(oldNode.htmlType_)) {
        // Leaves and not-yet-enabled containers: kept only when fully equal;
        // otherwise the level above swaps the slot.
        if (contentEqual(oldNode, newNode)) {
            recordSubtreeRemap(oldNode, newNode, remap);
            return true;
        }
        return false;
    }

    if (!!oldNode.isAutoFill_ !== !!newNode.isAutoFill_) return false;
    if (oldNode.isAutoFill_) {
        // Streaming-AI autofill row: mdSymbols_[0] carries the raw line text
        // (that is where the meaning lives), so it is kept only on a
        // byte-for-byte match.
        if (
            oldNode.mdSymbols_?.[0] === newNode.mdSymbols_?.[0] &&
            contentEqual(oldNode, newNode)
        ) {
            recordSubtreeRemap(oldNode, newNode, remap);
            return true;
        }
        return false;
    }

    const oc = oldNode.children_;
    const nc = newNode.children_;
    if (!oc || !nc) return false;

    // — Child-level two-ended equality scan (clamped against overlap) —
    let prefix = 0;
    const minLen = Math.min(oc.length, nc.length);
    while (prefix < minLen && contentEqual(oc[prefix], nc[prefix])) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < minLen - prefix &&
        contentEqual(oc[oc.length - 1 - suffix], nc[nc.length - 1 - suffix])
    ) {
        suffix += 1;
    }
    for (let i = 0; i < prefix; i++) recordSubtreeRemap(oc[i], nc[i], remap);
    for (let i = 0; i < suffix; i++) {
        recordSubtreeRemap(
            oc[oc.length - 1 - i],
            nc[nc.length - 1 - i],
            remap,
        );
    }

    const oMidLen = oc.length - prefix - suffix;
    const nMidLen = nc.length - prefix - suffix;
    // The cursor's text lives directly in this container's children → the kept
    // nodes flanking the changed region need a dirty-DOM flush (see the
    // bumpDomVersion note above).
    const dirtyDomGuard = oldNode.htmlType_ === MarkdownType.PreCode;
    if (oMidLen === nMidLen) {
        // Equal counts: recurse pairwise by position; a failed pairing
        // replaces that slot wholesale (a new uuid → a changed React key →
        // a remount for free).
        for (let k = 0; k < oMidLen; k++) {
            const oi = prefix + k;
            if (!mergeStructuralNode(oc[oi], nc[prefix + k], remap)) {
                oc[oi] = nc[prefix + k];
                if (dirtyDomGuard) {
                    bumpDomVersion(oc[oi - 1]);
                    bumpDomVersion(oc[oi + 1]);
                }
            }
        }
    } else {
        // Unequal counts: the insertion/deletion is in the middle, so splice
        // (the structural row, column and code-line operations).
        oc.splice(prefix, oMidLen, ...nc.slice(prefix, prefix + nMidLen));
        if (dirtyDomGuard) {
            bumpDomVersion(oc[prefix - 1]);
            bumpDomVersion(oc[prefix + nMidLen]);
        }
    }
    remap.set(newNode.uuid_, oldNode.uuid_);
    return true;
};

/**
 * Block-level entry: decides whether the old and new block can go through a
 * reference-preserving merge. Returning true means the old block (its uuid_
 * included) is kept, and the caller remaps the cursor uuid reported by the
 * parser onto the kept tree through `remap`.
 * - P: the block is itself an inline container;
 * - H1~H6 (same level on both sides): [MdSymbol, wrapper] — merge the wrapper;
 * - Table / Pre: the generic structural recursion (row / column / code-line
 *   granularity, span granularity inside a cell).
 * Everything else (a changed block type, a block split, li, lists, blockquotes)
 * falls back to the caller's whole-block splice.
 */
export const mergeParsedBlock = (
    oldBlock: Node,
    newBlock: Node,
    remap?: UuidRemap,
): boolean => {
    const map = remap ?? new Map<string, string>();
    if (oldBlock.htmlType_ !== newBlock.htmlType_) return false;
    if (!oldBlock.children_ || !newBlock.children_) return false;

    if (oldBlock.htmlType_ === MarkdownType.P) {
        if (
            mergeInlineContainer(
                oldBlock as ParentRenderData,
                newBlock as ParentRenderData,
            )
        ) {
            map.set(newBlock.uuid_, oldBlock.uuid_);
            return true;
        }
        return false;
    }

    if (HEADER_TYPES.has(oldBlock.htmlType_)) {
        const oc = oldBlock.children_;
        const nc = newBlock.children_;
        if (oc.length !== 2 || nc.length !== 2) return false;
        const [oSym, oWrap] = oc;
        const [nSym, nWrap] = nc;
        if (
            oSym.htmlType_ !== MarkdownType.MdSymbol ||
            nSym.htmlType_ !== MarkdownType.MdSymbol ||
            oSym.text_ !== nSym.text_
        ) {
            return false;
        }
        if (!oWrap.children_ || !nWrap.children_) return false;
        if (oWrap.htmlType_ !== nWrap.htmlType_) return false;
        if (
            mergeInlineContainer(
                oWrap as ParentRenderData,
                nWrap as ParentRenderData,
            )
        ) {
            map.set(newBlock.uuid_, oldBlock.uuid_);
            map.set(nWrap.uuid_, oWrap.uuid_);
            map.set(nSym.uuid_, oSym.uuid_);
            return true;
        }
        return false;
    }

    if (
        oldBlock.htmlType_ === MarkdownType.Table ||
        oldBlock.htmlType_ === MarkdownType.Pre
    ) {
        return mergeStructuralNode(oldBlock, newBlock, map);
    }

    return false;
};
