import { ParentRenderData, RenderData } from "../../../../../../type";
import Renderer from "../../index";
import { useEditorStore } from "../../../../../../store";
import { MarkdownType } from "../../../../../../type/enum";
import { HeadingTypes, HtmlTags, isSymbolType } from "../../../../../../constant";
import { memo } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { getSpanRenderIdProps } from "../../../../../props/getSpanRenderIdProps";
import { DATA_FILLER_BR } from "../../../../../../../data-parse/constant";

interface Props {
    parsedData: ParentRenderData | RenderData;
}

/**
 * Trailing-line filler test for P: when the paragraph text ends with \n (a
 * Shift+Enter soft break sitting at the end of the line), pre-wrap generates
 * no line box for that empty trailing line and Chrome's caret cannot get into
 * it (the same problem ProseMirror solves with trailingBreak; experimental
 * data in reference/zwsp-to-trailing-br-plan.md). Append a view-layer <br> to
 * prop the trailing line open. A \n in the middle already gets a line box
 * natively and needs no filler. Only the deepest last text leaf matters: a
 * trailing \n necessarily lands on it.
 */
const needsTrailingFiller = (
    parsedData: ParentRenderData | RenderData,
): boolean => {
    if (parsedData.htmlType_ !== MarkdownType.P) return false;
    let node: ParentRenderData | RenderData | undefined = parsedData;
    while (node?.children_?.length) {
        node = node.children_[node.children_.length - 1];
    }
    return !!node?.text_?.endsWith("\n");
};

const SYMBOL_TAIL_BLOCKS = new Set([MarkdownType.P, ...HeadingTypes]);

/** Walk backwards for the block's last non-empty text leaf (skipping leaves
 *  whose text_ is empty, such as img). */
const lastNonEmptyLeaf = (
    node: ParentRenderData | RenderData,
): RenderData | undefined => {
    if (!node.children_) {
        return node.text_ ? (node as RenderData) : undefined;
    }
    for (let i = node.children_.length - 1; i >= 0; i--) {
        const found = lastNonEmptyLeaf(node.children_[i]);
        if (found) return found;
    }
    return undefined;
};

/**
 * Symbol-tail filler test for rich mode: when a block's last non-empty leaf is
 * a syntax symbol (a trailing `**bold**`, an empty `# ` heading, an image's
 * source at the end of a block…), that symbol never reveals (display:none), so
 * the end of the block offers no visible caret landing spot "outside the
 * construct" — the cursor can only fall back inside the construct's content,
 * which makes subsequent typing continue the format (sticky-format). Append a
 * view-layer <br> filler (same mechanism, and the same key-remount discipline,
 * as the \n trailing-line filler): getDomByCursor's forward snapping lands on
 * the br → the caret sits outside the construct → typing produces plain text.
 * A <br> carries no text, so the model↔DOM counting invariant is unaffected.
 * Rich mode only: in markdown mode symbols reveal when the cursor is near
 * them, so the end of the block normally has a landing spot and the existing
 * DOM shape is left untouched.
 */
const needsSymbolTailFiller = (
    parsedData: ParentRenderData | RenderData,
): boolean => {
    if (!SYMBOL_TAIL_BLOCKS.has(parsedData.htmlType_)) return false;
    const leaf = lastNonEmptyLeaf(parsedData);
    return !!leaf && isSymbolType(leaf.htmlType_);
};

function BaseElement({ parsedData }: Props) {
    const isEditable = useEditorStore((store) => store.isEditable);
    const mode = useEditorStore((store) => store.mode);

    const Tag = HtmlTags[parsedData.htmlType_];

    const isContentEditable =
        isEditable && (parsedData.children_?.length ? true : undefined);

    const props = getRenderElementProps(parsedData);

    const hasTrailingFiller =
        needsTrailingFiller(parsedData) ||
        (mode === "rich" && needsSymbolTailFiller(parsedData));

    return (
        <Tag
            // Flip the key whenever the trailing filler appears/disappears
            // to force a remount of the whole block: when you type at the
            // trailing line (br, 0), Chrome moves or replaces the filler <br>
            // on its own (native behaviour for typing at a trailing br), and
            // letting React diff that br in or out inside the same P instance
            // would removeChild a node that no longer exists and crash
            // outright (NotFoundError). Flipping the key = unmount the old P,
            // mount a new one: unmounting only does removeChild on the P
            // itself (the browser never touches the P node, so that is always
            // safe), and it sweeps away any dirty DOM left over from
            // speculative input. Same idea as mergeInlineBlock's domVersion_
            // dirty-DOM guard, at whole-block granularity.
            key={hasTrailingFiller ? "trailing-filler" : "plain"}
            contentEditable={isContentEditable}
            {...props}
            {...getSpanRenderIdProps(parsedData)}
        >
            {parsedData.children_?.length
                ? parsedData.children_.map((child) => (
                      // The key carries domVersion_: span merging bumps the
                      // version of spans adjacent to "dirty DOM" to force a
                      // remount (see mergeInlineBlock.ts).
                      <Renderer
                          key={
                              child.domVersion_
                                  ? `${child.uuid_}@${child.domVersion_}`
                                  : child.uuid_
                          }
                          parsedData={child}
                      />
                  ))
                : parsedData.text_}
            {hasTrailingFiller && <br {...{ [DATA_FILLER_BR]: "true" }} />}
        </Tag>
    );
}

export default memo(BaseElement);
