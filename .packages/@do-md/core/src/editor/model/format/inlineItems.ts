import { isSymbolType } from "../../constant";
import { MarkdownType } from "../../type/enum";
import {
    InlineFormat,
    InlineFormatMark,
    ParentRenderData,
    RenderData,
} from "../../type";
// ⚠️ format ⇄ serialize module cycle (what the recursion turned into once the
// original single file was split): decomposeInlineItems calls toMarkdown to
// serialize atomic constructs, and toMarkdown calls serializeInlineWithFormat
// (→ toggledInlineItems) to flip formatting. Both directions call only from
// inside function bodies (call-time, not module-initialization time), which is
// safe under ESM live bindings.
import { toMarkdown } from "../serialize/toMarkdown";
import { marksOfNode } from "./marks";

const isPlainTextType = (t: MarkdownType) =>
    t === MarkdownType.Plain ||
    t === MarkdownType.InlinePlain ||
    t === MarkdownType.EmptyPlain;

export interface InlineItem {
    text: string;
    marks: Set<InlineFormatMark>;
    sp: number; // serialized start offset
    len: number;
    isCursor?: boolean;
}

/**
 * Flatten a block's inline content into a token stream in serialized order.
 * Each token is a visible char or an atomic construct (code/link/img/inline-
 * html/escape), tagged with its inline mark set. Delimiter symbols (`**`, `*`,
 * …) are consumed for offset accounting but not emitted — they are regenerated
 * from the mark set on re-serialization. `sp` is the offset into the block's
 * serialized string (the same coordinate `adjustCursor_` produces), so a
 * selection range expressed in those offsets maps directly onto items.
 */
// blockNode is frozen immutable by immer: same reference ⇒ same token stream.
// One range derivation of formatState triggers up to 6 tokenizations (the
// active test plus a star-conflict probe per mark), and it runs on every
// selectionchange while a selection is being dragged — the WeakMap cache
// collapses them into 1.
const inlineItemsCache = new WeakMap<object, InlineItem[]>();

export const decomposeInlineItems = (
    blockNode: ParentRenderData | RenderData,
): InlineItem[] => {
    const cached = inlineItemsCache.get(blockNode);
    if (cached) return cached;
    const items = decomposeInlineItemsUncached(blockNode);
    inlineItemsCache.set(blockNode, items);
    return items;
};

const decomposeInlineItemsUncached = (
    blockNode: ParentRenderData | RenderData,
): InlineItem[] => {
    const items: InlineItem[] = [];
    let sp = 0;

    const pushText = (text: string, marks: Set<InlineFormatMark>) => {
        for (const ch of text) {
            items.push({ text: ch, marks: new Set(marks), sp, len: 1 });
            sp += 1;
        }
    };
    const pushAtomic = (
        node: ParentRenderData | RenderData,
        marks: Set<InlineFormatMark>,
    ) => {
        const text = toMarkdown(node);
        items.push({ text, marks: new Set(marks), sp, len: text.length });
        sp += text.length;
    };

    const emitChildren = (
        node: ParentRenderData | RenderData,
        ambient: Set<InlineFormatMark>,
    ) => {
        for (const child of node.children_ || []) {
            dispatch(child, ambient);
        }
    };

    const dispatch = (
        child: ParentRenderData | RenderData,
        ambient: Set<InlineFormatMark>,
    ) => {
        const type = child.htmlType_;

        // Hidden/visible delimiter symbols: consume their serialized length but
        // emit nothing — markers are regenerated from the mark set.
        if (isSymbolType(type)) {
            sp += (child.text_ || "").length;
            return;
        }

        // A mark content node reached directly (inside a mark group).
        const ownMarks = marksOfNode(child);
        if (ownMarks) {
            const next = new Set(ambient);
            for (const bit of ownMarks) next.add(bit);
            if (child.children_) emitChildren(child, next);
            else pushText(child.text_ || "", next);
            return;
        }

        if (child.children_) {
            const contentChildren = child.children_.filter(
                (c) => !isSymbolType(c.htmlType_),
            );
            const sole =
                contentChildren.length === 1 ? contentChildren[0] : undefined;
            // Mark group wrapper (Plain > [sym, Bold/Em/…, sym]): descend so the
            // inner mark + any nesting is handled; delimiters regenerated.
            if (sole && marksOfNode(sole)) {
                emitChildren(child, ambient);
                return;
            }
            // Any other wrapper is an atomic construct whose delimiters live in
            // sibling MdSymbols (code/link/img/inline-html/escape) — emit the
            // whole subtree verbatim so those delimiters are preserved.
            pushAtomic(child, ambient);
            return;
        }

        // Bare leaf.
        if (isPlainTextType(type)) {
            pushText(child.text_ || "", ambient);
        } else {
            // Atomic leaf (e.g. image/code without wrapper).
            pushAtomic(child, ambient);
        }
    };

    emitChildren(blockNode, new Set());
    return items;
};

/** Items with the requested mark set/cleared over [lo, hi]. */
export const toggledInlineItems = (
    blockNode: ParentRenderData | RenderData,
    lo: number,
    hi: number,
    format: InlineFormat,
): InlineItem[] => {
    // decomposeInlineItems' output is shared through the WeakMap cache, so it
    // has to be shallow-copied (Sets included) before any mark is flipped —
    // otherwise the cached entry gets dirtied.
    const items = decomposeInlineItems(blockNode).map((it) => ({
        ...it,
        marks: new Set(it.marks),
    }));
    for (const item of items) {
        if (!(item.sp < hi && item.sp + item.len > lo)) continue;
        if (format.op === "add") item.marks.add(format.mark);
        else item.marks.delete(format.mark);
    }
    return items;
};
