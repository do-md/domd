import { CursorMarker } from "../../constant";
import { MarkdownType } from "../../type/enum";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
} from "../../type";
import { hardBreakSourceOf } from "../../../data-parse/hardBreak";

type AnyNode = ParentRenderData | RootRenderData | RenderData;

/**
 * Leaves that render no reading text even though they carry source text:
 * the hidden newline after an opening fence and the checkbox input (`[ ] `
 * in the source, a control on screen). A thematic break keeps its `---`,
 * the conventional plain-text divider; dropping it would leave a run of
 * blank lines where the rule was.
 */
const TEXTLESS_LEAVES = new Set<string>([
    MarkdownType.HideSecondLine,
    MarkdownType.CheckboxesInput,
]);

/** Block separators keep their line breaks and drop whatever syntax rides
 *  on them (`\n>\n` inside a quote, list continuation indentation). */
const SEPARATORS = new Set<string>([
    MarkdownType.LineBr,
    MarkdownType.LineBrBr,
]);

/**
 * A leaf's reading text, plus where a source offset inside the leaf lands in
 * it. Syntax symbols are recognized structurally — a node whose own uuid is
 * in its `mdSymbols_` IS a symbol (`#`, `**`, `[`, `](url)`, fences, inline
 * HTML tags, inline-rule delimiters…) — so new symbol kinds need no entry
 * here.
 */
const readLeaf = (
    leaf: RenderData,
): { text: string; project: (offset: number) => number } => {
    const source = leaf.text_ ?? "";
    if (
        leaf.mdSymbols_.includes(leaf.uuid_) ||
        TEXTLESS_LEAVES.has(leaf.htmlType_)
    ) {
        return { text: "", project: () => 0 };
    }
    if (SEPARATORS.has(leaf.htmlType_)) {
        return {
            text: source.replace(/[^\n]/g, ""),
            project: (offset) =>
                source.slice(0, offset).replace(/[^\n]/g, "").length,
        };
    }
    return { text: source, project: (offset) => offset };
};

const findRenderNode = (root: AnyNode, uuid: string): AnyNode | null => {
    const stack: AnyNode[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (node.htmlProps_?.["data-render-id"] === uuid) return node;
        if (node.children_) {
            for (let i = node.children_.length - 1; i >= 0; i -= 1) {
                stack.push(node.children_[i]);
            }
        }
    }
    return null;
};

/**
 * Resolve a cursor (render element uuid + offset in that element's source
 * text, the coordinate toMarkdown consumes) to the leaf that holds it. The
 * source text of a render element is the concatenation of its leaves, the
 * same text the DOM carries for it (hidden symbols stay in the DOM), so the
 * walk is a running sum. An offset on a leaf boundary resolves to the end of
 * the earlier leaf; both sides project to the same reading position.
 */
const anchorCursor = (
    root: AnyNode,
    cursor: CursorInfo,
): { leaf: RenderData; offset: number } | null => {
    const node = findRenderNode(root, cursor.uuid);
    if (!node) return null;
    const stack: AnyNode[] = [node];
    let remaining = cursor.offset;
    let last: RenderData | null = null;
    while (stack.length) {
        const cur = stack.pop()!;
        if (cur.children_) {
            for (let i = cur.children_.length - 1; i >= 0; i -= 1) {
                stack.push(cur.children_[i]);
            }
            continue;
        }
        const leaf = cur as RenderData;
        const length = (leaf.text_ ?? "").length;
        if (remaining <= length) return { leaf, offset: remaining };
        remaining -= length;
        last = leaf;
    }
    return last ? { leaf: last, offset: (last.text_ ?? "").length } : null;
};

/**
 * The plain-text counterpart of toMarkdown: the document as a reader sees it.
 * Syntax symbols are dropped, block structure survives as line breaks
 * (paragraphs keep their blank line, list items and quote lines their line),
 * a hard break (`<br>`) is a line break too, and a table becomes
 * tab-separated rows, multi-line cells quoted — what spreadsheets paste as
 * cells. Document text
 * only: view-only decorations a host renders around it are not part of the
 * model. The model is the source, never the DOM: a virtualized view only
 * mounts a window of blocks.
 *
 * `cursorInfos` injects CursorMarkers exactly like toMarkdown's, so a caller
 * can cut the selected span out of the output.
 */
export const toPlainText = (
    parsedData: AnyNode,
    cursorInfos: CursorInfo[] = [],
): string => {
    // leaf uuid -> source offsets of the markers it carries
    const markers = new Map<string, number[]>();
    for (const cursor of cursorInfos.slice(0, 2)) {
        const anchor = anchorCursor(parsedData, cursor);
        if (!anchor) continue;
        const list = markers.get(anchor.leaf.uuid_) ?? [];
        list.push(anchor.offset);
        markers.set(anchor.leaf.uuid_, list);
    }

    // Markers emitted so far, in document order (emission order).
    let markersEmitted = 0;

    const injectMarkers = (
        text: string,
        positions: number[],
    ): string => {
        let out = text;
        // Insert from the right so earlier positions stay valid.
        for (const position of [...positions].sort((a, b) => b - a)) {
            out = out.slice(0, position) + CursorMarker + out.slice(position);
        }
        markersEmitted += positions.length;
        return out;
    };

    const emitLeaf = (leaf: RenderData): string => {
        const { text, project } = readLeaf(leaf);
        const offsets = markers.get(leaf.uuid_);
        if (!offsets) return text;
        return injectMarkers(text, offsets.map(project));
    };

    // A hard break reads as a line break. Its source has a length and its
    // <br> has none, so a cursor anchors on the source symbol (anchorCursor
    // takes the earlier leaf at a boundary): any offset past the symbol's
    // start is after the break — the start of the next line.
    const emitHardBreak = (source: RenderData): string => {
        const offsets = markers.get(source.uuid_);
        if (!offsets) return "\n";
        return injectMarkers(
            "\n",
            offsets.map((offset) => (offset > 0 ? 1 : 0)),
        );
    };

    // A cell holding a line break (or a tab) is a multi-line field: quoted
    // the way spreadsheets read TSV ("" for a quote), so pasting the table
    // keeps one row per row. A cell that holds a selection endpoint stays
    // raw — the caller cuts there, and half a quoted field is worse than
    // none.
    const emitCell = (cell: AnyNode): string => {
        const before = markersEmitted;
        const text = emit(cell);
        if (markersEmitted !== before || !/[\n\t]/.test(text)) return text;
        return `"${text.split('"').join('""')}"`;
    };

    const emitTable = (table: AnyNode): string => {
        const rows: string[] = [];
        for (const section of table.children_ ?? []) {
            for (const tr of section.children_ ?? []) {
                rows.push((tr.children_ ?? []).map(emitCell).join("\t"));
            }
        }
        return rows.join("\n");
    };

    const emit = (node: AnyNode): string => {
        if (!node.children_) return emitLeaf(node as RenderData);
        if (node.htmlType_ === MarkdownType.Table) return emitTable(node);
        const hardBreak = hardBreakSourceOf(node);
        if (hardBreak) return emitHardBreak(hardBreak);
        let text = "";
        for (const child of node.children_) text += emit(child);
        return text;
    };

    return emit(parsedData);
};
