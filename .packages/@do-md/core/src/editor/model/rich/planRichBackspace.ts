import { ParentRenderData } from "../../type";
import { CursorMarker, HeadingTypes } from "../../constant";
import { getPrevGraphemeLength } from "../text/getPrevGraphemeLength";
import { flattenLeaves, isSymbolLeaf, Leaf } from "./flattenLeaves";
import { modelBlockText } from "./modelBlockText";

/**
 * Rich-mode backspace planner (mode === "rich" only).
 *
 * In rich mode syntax symbols are never revealed, so a literal one-char
 * delete produces invisible-garbage states (`**bold*` half-italic soup) or
 * gets stuck inside a construct forever. This planner rewrites a collapsed
 * backspace at block offset `index` into one of:
 *
 * - "text": a full replacement block text (CursorMarker embedded) covering
 *   three behaviours in one splice:
 *   1. TUNNEL — hop backward over hidden symbol leaves and delete the
 *      nearest visible grapheme instead (Notion/Word mental model);
 *   2. DISSOLVE — when that deletion empties a construct, its marker pair
 *      is removed in the same splice (never leaves a bare `****` literal);
 *   3. ATOMIC — a symbol run with zero content (image/badge: the whole
 *      markdown lives in symbol leaves) deletes as one unit;
 *   plus heading demote: tunnelling through the leading `# ` marker strips
 *   it, turning the heading into a paragraph (rich-editor convention).
 * - "blockStart": tunnelling reached offset 0 with no marker to strip —
 *   the caller should run its existing visual-block-start semantics
 *   (merge/outdent), formatting untouched.
 * - "fallthrough": planner does not apply (model/DOM text mismatch, cursor
 *   not adjacent to anything special) — caller keeps its original path.
 *
 * Pure model-level function: operates on the block's RenderData leaves and
 * its serialized text. It never touches the DOM, so it is offline-testable.
 * The model==DOM text invariant is asserted (concat check) before any plan
 * is produced; on mismatch we fall through to the untouched legacy path.
 */

export type RichBackspacePlan =
    | { kind_: "fallthrough" }
    | { kind_: "blockStart" }
    | { kind_: "text"; text_: string };

/** Build the replacement text: original text minus `removals` ranges, with
 *  CursorMarker where the range starting at `markerAt` was removed. Ranges
 *  must be disjoint. */
const spliceOut = (
    text: string,
    removals: Array<[number, number]>,
    markerAt: number,
): string => {
    const sorted = [...removals].sort((a, b) => a[0] - b[0]);
    let out = "";
    let pos = 0;
    for (const [s, e] of sorted) {
        out += text.slice(pos, s);
        if (s === markerAt) out += CursorMarker;
        pos = Math.max(pos, e);
    }
    out += text.slice(pos);
    return out;
};

export const planRichBackspace = (
    renderData: ParentRenderData,
    text: string,
    index: number,
): RichBackspacePlan => {
    if (index <= 0 || index > text.length) return { kind_: "fallthrough" };

    const leaves = flattenLeaves(renderData);
    // model==DOM text invariant guard: if the DOM read (`text`) and the model
    // leaves disagree (pending input in flight), stay on the legacy path.
    if (modelBlockText(renderData) !== text) return { kind_: "fallthrough" };

    const leafAt = (charIndex: number): Leaf | undefined =>
        leaves.find((l) => l.start_ <= charIndex && charIndex < l.end_);

    // Per-symbol-id visible content length (symbol leaves excluded). Used
    // both for atomic detection (0-content constructs) and dissolve.
    const contentLen = new Map<string, number>();
    for (const l of leaves) {
        if (isSymbolLeaf(l.data_)) continue;
        for (const id of l.data_.mdSymbols_ ?? []) {
            contentLen.set(id, (contentLen.get(id) ?? 0) + (l.end_ - l.start_));
        }
    }

    // Tunnel backward over hidden symbol leaves.
    let p = index;
    const crossed: Leaf[] = [];
    while (p > 0) {
        const leaf = leafAt(p - 1);
        if (!leaf) return { kind_: "fallthrough" };
        if (!isSymbolLeaf(leaf.data_)) break;
        const ids = leaf.data_.mdSymbols_ ?? [];
        // ATOMIC construct (image/badge…): all of its markdown lives in
        // symbol leaves, content length is 0. Backspace deletes it whole —
        // tunnelling over it would silently eat the char before an image.
        if (ids.length && ids.every((id) => (contentLen.get(id) ?? 0) === 0)) {
            const members = leaves.filter((l) =>
                (l.data_.mdSymbols_ ?? []).some((id) => ids.includes(id)),
            );
            const start = Math.min(...members.map((l) => l.start_));
            const end = Math.max(...members.map((l) => l.end_));
            return {
                kind_: "text",
                text_: spliceOut(text, [[start, end]], start),
            };
        }
        crossed.push(leaf);
        p = leaf.start_;
    }

    if (p === 0) {
        if (!crossed.length) return { kind_: "fallthrough" };
        // Heading demote: backspace at the visual start of a heading strips
        // the leading `# ` marker → paragraph (rich-editor convention).
        if (HeadingTypes.has(renderData.htmlType_)) {
            const markerEnd = Math.max(...crossed.map((l) => l.end_));
            return {
                kind_: "text",
                text_: CursorMarker + text.slice(markerEnd),
            };
        }
        // Inline construct at block start: keep formatting, let the caller
        // run its visual-block-start semantics (merge/outdent).
        return { kind_: "blockStart" };
    }

    // Delete the grapheme ending at p (the nearest visible char).
    const k = getPrevGraphemeLength(text, p);
    const g0 = p - k;
    const target = leafAt(p - 1);
    if (!target || leafAt(g0) !== target) return { kind_: "fallthrough" };

    // Nothing special adjacent and no construct involved → legacy path
    // (identical result, but keeps rich mode off the hot path entirely).
    if (!crossed.length && !(target.data_.mdSymbols_ ?? []).length) {
        return { kind_: "fallthrough" };
    }

    // DISSOLVE: constructs whose visible content this deletion empties lose
    // their symbol leaves in the same splice.
    const emptied = new Set<string>();
    for (const id of target.data_.mdSymbols_ ?? []) {
        if ((contentLen.get(id) ?? 0) - k <= 0) emptied.add(id);
    }
    const removals: Array<[number, number]> = [[g0, p]];
    if (emptied.size) {
        for (const l of leaves) {
            if (!isSymbolLeaf(l.data_)) continue;
            if ((l.data_.mdSymbols_ ?? []).some((id) => emptied.has(id))) {
                removals.push([l.start_, l.end_]);
            }
        }
    }
    return { kind_: "text", text_: spliceOut(text, removals, g0) };
};
