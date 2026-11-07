import { AnyNode, ParentRenderData, RenderData } from "../editor/type";
import { MarkdownType } from "../editor/type/enum";
import { createTextRenderData } from "./create-render-data/createTextRenderData";

/**
 * Inline hard line breaks written as raw HTML — `<br>`, `<br/>`, `<br />`.
 *
 * In running text (paragraphs, headings, list items) parseInline builds the
 * same atomic group an image gets: a hidden MdSymbol carrying the exact
 * source, next to a HardBreak leaf that renders the real <br>. The source
 * stays in the model, so the Markdown round-trip is byte-exact and `<br>`
 * never turns into the `\n` the author did not write.
 *
 * Table cells are different. A GFM row is one line, so a cell has no newline
 * of its own and `<br>` is how a line break inside a cell is written (what
 * GitHub, Typora and Obsidian render and write). Inside a cell the break is
 * therefore modelled as an ordinary "\n" — the same character a paragraph
 * soft break is — so the caret, backspace, forward delete, IME, the
 * trailing-line filler and every other piece of editing machinery handle it
 * with no break-specific code. `<br>` exists only in the cell's markdown
 * form; the two forms are converted at the table boundary, the same layer
 * that pads the columns:
 *   - markdown → model: lowerCellHardBreaks, run by the cell parse after the
 *     inline parser (so code spans and escapes keep a literal `<br>`);
 *   - model → markdown: encodeCellBreaks, run by the table serializer and by
 *     every edit that writes text into a cell through the table's markdown.
 * Spelling variants (`<br/>`, `<BR>`) come back as `<br>` — a table does not
 * round-trip byte-exact anyway (the column padding is canonical).
 */

/** The markdown spelling of a line break inside a table cell. */
export const CELL_BREAK = "<br>";

/** Model form → markdown form of a cell's text: every "\n" is a cell line
 *  break. CursorMarkers pass through untouched. Idempotent on markdown form,
 *  which never holds a raw "\n". */
export const encodeCellBreaks = (text: string): string =>
    text.includes("\n") ? text.split("\n").join(CELL_BREAK) : text;

/** The source MdSymbol of a hard-break group, or null when `node` is not one.
 *  The group shape is parseInline's: Plain[MdSymbol(source), HardBreak]. */
export const hardBreakSourceOf = (node: AnyNode): RenderData | null => {
    const children = (node as ParentRenderData).children_;
    if (
        children?.length !== 2 ||
        children[1].htmlType_ !== MarkdownType.HardBreak ||
        children[0].htmlType_ !== MarkdownType.MdSymbol
    ) {
        return null;
    }
    return children[0] as RenderData;
};

/** One lowered break: where its source started in the block's markdown-form
 *  text, and how long that source was. */
export interface LoweredBreak {
    at_: number;
    length_: number;
}

const isMergeableText = (node: AnyNode): node is RenderData =>
    !(node as ParentRenderData).children_ &&
    node.htmlType_ === MarkdownType.Plain &&
    Object.keys(node.htmlProps_ ?? {}).length === 0;

const sameSymbols = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Lower every hard-break group inside a freshly parsed cell block into a "\n"
 * text leaf, in place. The new leaf keeps the group's own mdSymbols_ (the
 * constructs it sits in, e.g. `**a<br>b**`) and is merged with the plain text
 * on either side, so `a<br>b` becomes the single leaf "a\nb" — exactly what a
 * soft break looks like in a paragraph. Returns the lowered breaks in
 * document order, for mapLoweredOffset.
 */
export const lowerCellHardBreaks = (block: ParentRenderData): LoweredBreak[] => {
    const breaks: LoweredBreak[] = [];
    let pos = 0;

    const visit = (parent: ParentRenderData) => {
        const out: AnyNode[] = [];
        // The leaf a lowered "\n" went into: the next plain sibling with the
        // same symbols continues it.
        let open: RenderData | null = null;
        for (const child of parent.children_) {
            const source = hardBreakSourceOf(child);
            if (source) {
                const length = source.text_?.length ?? 0;
                breaks.push({ at_: pos, length_: length });
                pos += length;
                const last = out[out.length - 1];
                if (
                    last &&
                    isMergeableText(last) &&
                    sameSymbols(last.mdSymbols_, child.mdSymbols_)
                ) {
                    last.text_ += "\n";
                    open = last;
                } else {
                    open = createTextRenderData({
                        text_: "\n",
                        mdSymbols_: [...child.mdSymbols_],
                    });
                    out.push(open);
                }
                continue;
            }
            if ((child as ParentRenderData).children_) {
                visit(child as ParentRenderData);
                out.push(child);
                open = null;
                continue;
            }
            pos += child.text_?.length ?? 0;
            if (
                open &&
                isMergeableText(child) &&
                sameSymbols(open.mdSymbols_, child.mdSymbols_)
            ) {
                open.text_ += child.text_ ?? "";
            } else {
                out.push(child);
                open = null;
            }
        }
        parent.children_ = out;
    };

    visit(block);
    return breaks;
};

/** Map an offset in the block's markdown-form text to the lowered model text.
 *  An offset inside a break's source (a caret marker spliced into `<b|r>`)
 *  lands after the break. */
export const mapLoweredOffset = (
    offset: number,
    breaks: LoweredBreak[],
): number => {
    let removed = 0;
    for (const { at_, length_ } of breaks) {
        if (offset <= at_) break;
        if (offset < at_ + length_) return at_ - removed + 1;
        removed += length_ - 1;
    }
    return offset - removed;
};
