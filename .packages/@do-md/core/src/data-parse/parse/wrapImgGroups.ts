import { nanoid8 } from "@do-md/utils";
import { MarkdownType } from "../../editor/type/enum";
import { ParentRenderData, RenderData } from "../../editor/type";

/**
 * Image-group aggregation pass (opt-in, see the store's `imgGroupSeparators`
 * config).
 *
 * Runs at the exit of parseActualP and scans the **top-level children** of a
 * P block: every maximal run of "≥2 adjacent image wrapper nodes
 * (Plain[MdSymbol+Img]) separated only by valid separator text leaves" is
 * spliced into a single `MarkdownType.ImgGroup` wrapper node.
 *
 * The key invariant — aggregation and fidelity never interfere:
 * - The original children **move into the group verbatim, not one character
 *   changes**: the separator text (spaces, commas, …) is kept in place as a
 *   text child of the group, never swallowed and never normalized.
 *   toMarkdown and the text-count walk both recurse through children, so the
 *   extra wrapper layer is transparent to them → byte-exact round-trip.
 * - Default rendering: ImgGroup goes through BaseElement's layout-neutral
 *   inline span and its children still render recursively, so it is
 *   pixel-identical to not aggregating at all.
 *
 * Semantic boundaries (decisions on record, mirrored in the docs):
 * - `imgGroupSeparators` is the **set of characters allowed to appear in the
 *   separator text** (not an exact string match): `" "` covers any run of
 *   spaces, `", "` covers commas and spaces mixed together; the empty string
 *   `""` = only images that touch (no separator text node at all) group.
 * - `\n` is never a valid separator (it is stripped even when passed in the
 *   config): images split by a soft break do not group, and a blank line
 *   splits them into separate blocks long before this point (cross-block
 *   grouping is not supported).
 * - The group runs from the first image to the last only: the text on either
 *   side (spaces included) stays outside, and a trailing separator does not
 *   enter the group.
 * - Only the top-level children of a P are scanned: badges (an image nested
 *   in a Link) and images inside bold / inline-rule spans do not take part.
 * - A single image is never wrapped in a group (≥2 required), so existing
 *   single-image shapes are completely unchanged.
 *
 * Cursor: CursorMarker has already been stripped at the entry of
 * parseActualP and recorded as a block-level offset, and is only consumed
 * again after this pass — the separator-text test can never run into a
 * marker character.
 */

/** `\n`/`\r` are hard-excluded: not aggregating across a soft break is a
 *  product decision, so passing them in the config has no effect. */
const buildSeparatorSet = (separators: string): Set<string> => {
    const set = new Set<string>();
    for (const ch of separators) {
        if (ch === "\n" || ch === "\r") continue;
        set.add(ch);
    }
    return set;
};

/** A standard image wrapper node: the Plain parent node parseInline emits,
 *  whose children contain an Img. (A badge image sits under a Link, and an
 *  image inside a styling span is not a top-level Plain parent — both are
 *  excluded for free.) */
const isImgWrapper = (node: ParentRenderData | RenderData): boolean => {
    if (node.htmlType_ !== MarkdownType.Plain) return false;
    const children = (node as ParentRenderData).children_;
    if (!children) return false;
    return children.some((child) => child.htmlType_ === MarkdownType.Img);
};

/** A valid separator leaf: a text leaf with no children whose every
 *  character is in the separator character set. */
const isSeparatorLeaf = (
    node: ParentRenderData | RenderData,
    separatorSet: Set<string>,
): boolean => {
    if ((node as ParentRenderData).children_) return false;
    if (separatorSet.size === 0) return false;
    const text = (node as RenderData).text_;
    if (!text) return false;
    for (const ch of text) {
        if (!separatorSet.has(ch)) return false;
    }
    return true;
};

export const wrapImgGroups = (
    parent: ParentRenderData,
    separators: string,
): void => {
    const children = parent.children_;
    if (!children || children.length < 2) return;
    const separatorSet = buildSeparatorSet(separators);

    for (let i = 0; i < children.length; i += 1) {
        if (!isImgWrapper(children[i])) continue;

        // Greedy extension: img (separator* img)+ ; a separator leaf only
        // counts toward the run when another image follows it (a trailing
        // separator is left outside the group).
        let end = i;
        let imgCount = 1;
        let j = i + 1;
        while (j < children.length) {
            if (isImgWrapper(children[j])) {
                end = j;
                imgCount += 1;
                j += 1;
            } else if (isSeparatorLeaf(children[j], separatorSet)) {
                let k = j + 1;
                while (
                    k < children.length &&
                    isSeparatorLeaf(children[k], separatorSet)
                ) {
                    k += 1;
                }
                if (k < children.length && isImgWrapper(children[k])) {
                    end = k;
                    imgCount += 1;
                    j = k + 1;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        if (imgCount >= 2) {
            const run = children.slice(i, end + 1);
            const group: ParentRenderData = {
                htmlType_: MarkdownType.ImgGroup,
                children_: run,
                uuid_: nanoid8(),
                mdSymbols_: [],
                htmlProps_: {},
            };
            children.splice(i, run.length, group);
        }
        // The loop resumes scanning for the next run after the group (or
        // after the single image that was not aggregated).
    }
};
