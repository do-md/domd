import { MarkdownType } from "../../type/enum";
import {
    InlineFormatMark,
    ParentRenderData,
    RenderData,
} from "../../type";

/**
 * The inline formatting engine's mark vocabulary: node type → mark bits, open
 * and close delimiters, nesting order. The single source of truth the whole
 * engine shares — regenerating delimiters on serialization, conflict probing
 * and wrapping all read from here.
 */

// Inline marks contributed by a node type. EmBold carries both axes so
// stripping one axis naturally downgrades it (e.g. `***x***` --strip bold-->
// `*x*`). Types not listed are either plain text or atomic (code/link/img/
// inline-html), which are never decomposed into marks here.
const MARK_OF_TYPE: Partial<Record<MarkdownType, InlineFormatMark[]>> = {
    [MarkdownType.Em]: ["italic"],
    [MarkdownType.Bold]: ["bold"],
    [MarkdownType.EmBold]: ["bold", "italic"],
    [MarkdownType.Del]: ["strike"],
    [MarkdownType.Mark]: ["highlight"],
    // Underline is the HTML tag `<u>…</u>` (no markdown delimiter), so its
    // open/close symbols differ — see MARK_OPEN / MARK_CLOSE.
    [MarkdownType.U]: ["underline"],
};

// Open and close delimiters per mark. Symmetric for markdown marks; underline
// uses asymmetric HTML tags.
export const MARK_OPEN: Record<InlineFormatMark, string> = {
    highlight: "==",
    underline: "<u>",
    strike: "~~",
    bold: "**",
    italic: "*",
};
export const MARK_CLOSE: Record<InlineFormatMark, string> = {
    highlight: "==",
    underline: "</u>",
    strike: "~~",
    bold: "**",
    italic: "*",
};

// Nesting order, outermost -> innermost. Re-serialization always opens marks
// in this order and closes in reverse, so a {bold,italic} run becomes the
// fused `***...***` our parser understands, and adjacent runs only emit the
// delta (no ambiguous `*****` runs). Underline (HTML tag) nests outside the
// star marks so it never wedges between them.
export const MARK_ORDER: InlineFormatMark[] = [
    "highlight",
    "underline",
    "strike",
    "bold",
    "italic",
];

/**
 * Inline marks contributed by a node. v1 shim on top of MARK_OF_TYPE:
 * `==` highlight now parses as InlineRuleSpan (rule engine, see
 * inline-rules-design.md §5), not MarkdownType.Mark — a rule span rendering
 * <mark> contributes the highlight bit so the toggle's strip direction still
 * detects it. Every other rule span stays unlisted → atomic passthrough
 * (delimiters preserved verbatim on format rewrites).
 */
export const marksOfNode = (
    node: ParentRenderData | RenderData,
): InlineFormatMark[] | undefined => {
    if (
        node.htmlType_ === MarkdownType.InlineRuleSpan &&
        node.tagName_ === "mark"
    ) {
        return MARK_OF_TYPE[MarkdownType.Mark];
    }
    return MARK_OF_TYPE[node.htmlType_];
};

/** Normalize a mark set into an ordered list, following MARK_ORDER. */
export const orderMarks = (set: Set<InlineFormatMark>) =>
    MARK_ORDER.filter((m) => set.has(m));
