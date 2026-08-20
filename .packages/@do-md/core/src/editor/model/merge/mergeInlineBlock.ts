import { MarkdownType } from "../../type/enum";
import { ParentRenderData, RenderData } from "../../type";
import { createTextRenderData } from "../../../data-parse/create-render-data/createTextRenderData";

/**
 * Span-preserving merge: on a block-level reparse, merge the fresh parse into
 * the old block using "a char-level common prefix/suffix diff + snapping to
 * top-level child boundaries", instead of splicing the whole block away for a
 * new one.
 *
 * Motivation: resetTextByUUID_ rebuilt the block's entire children on every
 * apply, so every node got a new uuid → every React key changed and that whole
 * stretch of DOM was rebuilt, and the immer patch was a whole-block replace
 * (leaving the CRDT side with nothing finer than paragraph-level LWW). After
 * the merge:
 * - old spans outside the changed region **keep their object identity**
 *   (immer's structural sharing → zero patches, React skips them outright → the
 *   DOM does not move, and cursor replay is a no-op most of the time);
 * - the changed region is swapped for brand-new spans (new uuids). A span is an
 *   immutable atom: only ever created and deleted, never modified — and that
 *   invariant is what keeps the CRDT side from ever needing a deep merge.
 *
 * The algorithm (design discussion: graph task-410f7d):
 * 1. Flatten both containers into char streams, each char tagged with a
 *    "format signature" (its chain of ancestor htmlType_ values + href/src).
 *    Same text but changed formatting → different signature → it correctly
 *    falls inside the changed region.
 * 2. Two while loops scan out the common prefix/suffix (clamped against
 *    overlap — "aa" → "aaa" is the classic off-by-one).
 * 3. The changed region grows outward to the old container's **top-level child
 *    boundaries** (span atomicity: an affected top-level subtree is replaced
 *    whole, never cut open to preserve a uuid — cutting it open degrades to the
 *    LWW semantics of replacing text_). If a boundary on the new side falls
 *    inside a subtree that is not plain text, a fixpoint loop keeps growing.
 * 4. Fill back in: the prefix/suffix regions copy the old references
 *    unconditionally (the old sequence of finer-grained spans survives
 *    verbatim; however the fresh parse happened to divide it up is
 *    irrelevant); the changed region takes the corresponding top-level children
 *    from the new tree, where plain-text leaves may be sliced per character.
 *
 * Complexity is O(container text length). This only covers the common typing
 * path of "one block → one block of the same type"; everything else (a changed
 * block type, a block split, li) falls back to the caller's whole-block splice.
 */

type InlineNode = RenderData | ParentRenderData;

export interface FlatChar {
    /** the character itself (UTF-16 code unit) */
    c_: string;
    /** format signature of the leaf this char belongs to */
    s_: string;
}

interface FlatContainer {
    chars_: FlatChar[];
    /** char start offset of each top-level child; last entry = total length */
    bounds_: number[];
}

/**
 * A node's slice of the signature: structural information (type + semantic
 * props), and **never uuid_ / mdSymbols_** — those are regenerated on every
 * parse (fresh nanoids), so including them would mean nothing ever matches.
 */
const nodeSigPart = (node: InlineNode): string => {
    let part = String(node.htmlType_);
    const href = node.htmlProps_?.href;
    const src = node.htmlProps_?.src;
    if (typeof href === "string") part += "@" + href;
    if (typeof src === "string") part += "@" + src;
    return part;
};

/** Collects a subtree's leaf characters (with signatures) and returns the
 *  subtree's text width. mergeStructural also uses it for content equality
 *  that ignores how the text is partitioned into spans. */
export const collectChars = (
    node: InlineNode,
    ancestorSig: string,
    out: FlatChar[],
): number => {
    const sig = ancestorSig + "/" + nodeSigPart(node);
    if (node.children_) {
        let width = 0;
        for (const child of node.children_) {
            width += collectChars(child, sig, out);
        }
        return width;
    }
    const text = node.text_ || "";
    for (let i = 0; i < text.length; i += 1) {
        out.push({ c_: text[i], s_: sig });
    }
    return text.length;
};

/** Flattens a container; returns null when some top-level child is zero-width
 *  (ambiguous boundary) → the caller falls back */
const flattenContainer = (container: ParentRenderData): FlatContainer | null => {
    const chars: FlatChar[] = [];
    const bounds: number[] = [0];
    let total = 0;
    for (const child of container.children_) {
        const width = collectChars(child, "", chars);
        if (width === 0) return null;
        total += width;
        bounds.push(total);
    }
    return { chars_: chars, bounds_: bounds };
};

/** A top-level plain-text leaf: carries no markdown semantics, so it may be
 *  sliced per character */
const isSliceableText = (node: InlineNode): boolean =>
    !node.children_ &&
    node.htmlType_ === MarkdownType.Plain &&
    node.mdSymbols_.length === 0;

/** The largest bounds value ≤ pos */
const snapDown = (bounds: number[], pos: number): number => {
    let result = bounds[0];
    for (const b of bounds) {
        if (b <= pos) result = b;
        else break;
    }
    return result;
};

/** The smallest bounds value ≥ pos */
const snapUp = (bounds: number[], pos: number): number => {
    for (const b of bounds) {
        if (b >= pos) return b;
    }
    return bounds[bounds.length - 1];
};

/** Index of the child pos falls in (bounds_[k] ≤ pos < bounds_[k+1]); -1 when
 *  there is none */
const childAt = (bounds: number[], pos: number): number => {
    for (let k = 0; k < bounds.length - 1; k += 1) {
        if (bounds[k] <= pos && pos < bounds[k + 1]) return k;
    }
    return -1;
};

const isHighSurrogate = (ch: string | undefined): boolean =>
    !!ch && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff;
const isLowSurrogate = (ch: string | undefined): boolean =>
    !!ch && ch.charCodeAt(0) >= 0xdc00 && ch.charCodeAt(0) <= 0xdfff;

/**
 * Merges newContainer (this parse's output) into oldContainer (an immer draft).
 * Returns true when the merge completed (including the "identical, zero
 * changes" case); false means it cannot be merged and the caller falls back to
 * a whole-block splice. When it returns false, nothing has been modified.
 */
export const mergeInlineContainer = (
    oldContainer: ParentRenderData,
    newContainer: ParentRenderData,
): boolean => {
    const a = flattenContainer(oldContainer);
    if (!a) return false;
    const b = flattenContainer(newContainer);
    if (!b) return false;

    const lenA = a.chars_.length;
    const lenB = b.chars_.length;
    if (!lenA || !lenB) return false;
    const minLen = Math.min(lenA, lenB);

    // — Common prefix (advances only while both the char and the signature
    // match) —
    let prefixLen = 0;
    while (
        prefixLen < minLen &&
        a.chars_[prefixLen].c_ === b.chars_[prefixLen].c_ &&
        a.chars_[prefixLen].s_ === b.chars_[prefixLen].s_
    ) {
        prefixLen += 1;
    }

    // Identical: zero changes, and not a single patch is produced
    if (prefixLen === lenA && prefixLen === lenB) return true;

    // — Common suffix (clamped to prefix + suffix ≤ minLen so the two cannot
    // overlap) —
    let suffixLen = 0;
    while (
        suffixLen < minLen - prefixLen &&
        a.chars_[lenA - 1 - suffixLen].c_ === b.chars_[lenB - 1 - suffixLen].c_ &&
        a.chars_[lenA - 1 - suffixLen].s_ === b.chars_[lenB - 1 - suffixLen].s_
    ) {
        suffixLen += 1;
    }

    // Surrogate-pair guard: a boundary must not cut an emoji (or any other
    // surrogate pair) in half
    if (prefixLen > 0 && isHighSurrogate(a.chars_[prefixLen - 1].c_)) {
        prefixLen -= 1;
    }
    if (suffixLen > 0 && isLowSurrogate(a.chars_[lenA - suffixLen].c_)) {
        suffixLen -= 1;
    }

    // — Grow the changed region out to the old side's top-level child
    // boundaries; a fixpoint handles non-text subtrees on the new side —
    let pOld = snapDown(a.bounds_, prefixLen);
    const newChildren = newContainer.children_;
    for (let guard = 0; guard <= newChildren.length + 1; guard += 1) {
        const pNew = pOld;
        const k = pNew < lenB ? childAt(b.bounds_, pNew) : -1;
        if (k === -1 || b.bounds_[k] === pNew) break;
        if (isSliceableText(newChildren[k])) break;
        // The start landed inside a non-text subtree on the new side → grow to
        // that subtree's start, then snap back to an old boundary
        pOld = snapDown(a.bounds_, b.bounds_[k]);
    }

    let qOld = snapUp(a.bounds_, lenA - suffixLen);
    for (let guard = 0; guard <= newChildren.length + 1; guard += 1) {
        const qNew = lenB - (lenA - qOld);
        const k = qNew < lenB ? childAt(b.bounds_, qNew) : -1;
        if (k === -1 || b.bounds_[k] === qNew) break;
        if (isSliceableText(newChildren[k])) break;
        // The end landed inside a non-text subtree on the new side → grow to
        // that subtree's end, then snap back to an old boundary
        qOld = snapUp(a.bounds_, lenA - (lenB - b.bounds_[k + 1]));
    }

    const pNew = pOld;
    const qNew = lenB - (lenA - qOld);

    // — The new side's top-level children covering [pNew, qNew) become the
    // replacement content for the changed region —
    const middle: InlineNode[] = [];
    for (let k = 0; k < newChildren.length; k += 1) {
        const s = b.bounds_[k];
        const e = b.bounds_[k + 1];
        if (e <= pNew) continue;
        if (s >= qNew) break;
        if (s >= pNew && e <= qNew) {
            middle.push(newChildren[k]);
            continue;
        }
        // Partial coverage: the fixpoint already guarantees this can only be a
        // plain-text leaf — defensive fallback
        if (!isSliceableText(newChildren[k])) return false;
        const text = (newChildren[k] as RenderData).text_.slice(
            Math.max(s, pNew) - s,
            Math.min(e, qNew) - s,
        );
        if (text) middle.push(createTextRenderData({ text_: text }));
    }

    // — Splice the changed region; the old children in the prefix/suffix
    // regions **keep their references as they are** —
    const iStart = a.bounds_.indexOf(pOld);
    const iEnd = a.bounds_.indexOf(qOld);
    if (iStart === -1 || iEnd === -1 || iStart > iEnd) return false;
    oldContainer.children_.splice(iStart, iEnd - iStart, ...middle);

    // — Dirty-DOM guard: force a remount of the spans flanking the changed
    // region —
    // During speculative rendering the browser wrote the input straight into
    // the DOM text node the cursor sits in, and that node necessarily belongs
    // to a span next to the changed region (spans inside the changed region are
    // replaced wholesale anyway). That neighbouring span's model did not change
    // → React memo and the vdom both skip it → the dirty text sticks around.
    // Bumping domVersion_ (the uuid stays put) changes BaseElement's key and so
    // triggers a remount, rebuilding the DOM from the model. domVersion_ is not
    // serialized and takes no part in the sync diff → zero CRDT noise.
    const bumpDomVersion = (node: InlineNode | undefined) => {
        if (node) node.domVersion_ = (node.domVersion_ || 0) + 1;
    };
    bumpDomVersion(oldContainer.children_[iStart - 1]);
    bumpDomVersion(oldContainer.children_[iStart + middle.length]);
    return true;
};

// mergeParsedBlock (the block-level entry) has moved to ./mergeStructural —
// on top of P/Header it adds the generic structural recursion for Table/Pre
// plus the cursor uuid remapping table.
