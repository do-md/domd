import {
    CursorInfo,
    CursorSource,
    InlineFormatMark,
    ParentRenderData,
    RenderData,
} from "../type";
import { MarkdownType } from "../type/enum";
import { getCursorInfoByParseData } from "../model/cursor/getCursorInfoByParseData";
import { getNodeInfo } from "../model/tree/getNodeInfo";
import { getRenderDataById } from "../model/tree/getRenderDataById";
import { toMarkdown } from "../model/serialize/toMarkdown";
import { getCursorInfo, getCursorInfoOfRange } from "./lib/getCursorInfo";
import { CursorMarker, ZeroWidthSpace } from "../constant";
import { isCursorAfterSymbol } from "../model/rich/isCursorAfterSymbol";
import { normalizeRichCursorOffset } from "../model/rich/normalizeRichCursorOffset";
import { planRichBackspace } from "../model/rich/planRichBackspace";
import { isModelDomInSync } from "./lib/isModelDomInSync";
import { EditorStore } from "../store";
import { addEffect } from "@do-md/zenith";
import { copyTextToClipboard, debounceWithRAF } from "@do-md/utils";
import { parseMarkdown } from "../../data-parse/parseMarkdown";
import { splitTextSpans } from "../../data-parse/postprocess/splitTextSpans";
import { TextOperator } from "../model/text/TextOperator";
import { checkNeedRender } from "./lib/checkDomNeedRender";
import { getVisibleDomText } from "./lib/getVisibleDomText";
import { getOffsetTop } from "./lib/getOffsetTop";
import { getDomByCursor } from "./lib/getDomByCursor";
import { getRenderDomByID } from "./lib/getRenderDomByID";
import { getClosestRenderDom } from "./lib/getClosestRenderDom";
import { getIdByRenderDom } from "./lib/getIdByRenderDom";
import { getVisibleRangeLength } from "./lib/getVisibleRangeLength";
import { getLineExtent } from "./lib/getLineExtent";
import { commandKey, foreignCommandKey } from "./lib/commandKey";

import { matchesNewlineKey } from "./lib/matchesNewlineKey";
import { matchesLetterKey } from "./lib/matchesLetterKey";

/** beforeinput format* inputTypes we take over and map to an inline mark. */
const FORMAT_INPUT_TYPES: Record<string, InlineFormatMark> = {
    formatBold: "bold",
    formatItalic: "italic",
    formatStrikeThrough: "strike",
    // iOS / desktop Cmd+U → `<u>…</u>` (markdown has no underline syntax)
    formatUnderline: "underline",
};

/**
 * beforeinput delete* inputTypes taken over by the range mechanism
 * (deleteRangeInCursor_). Forward: fn+Delete / Ctrl+D →
 * deleteContentForward, Option+fn+Delete → deleteWordForward, Ctrl+K
 * (macOS delete-to-end-of-paragraph emacs binding) →
 * deleteSoftLineForward / deleteHardLineForward depending on the engine.
 * Backward: Cmd+Delete → deleteSoftLineBackward / deleteHardLineBackward,
 * Option+Delete → deleteWordBackward, Ctrl+U → deleteEntireSoftLine.
 * The one deliberate absentee is deleteContentBackward — plain backspace
 * keeps its dedicated path (taken over at keydown, with the beforeinput
 * branch as soft-keyboard fallback: planRichBackspace symbol tunneling
 * and the structural block-start cases). The direction tag drives a
 * single rule:
 * a backward range that crosses into the previous block is re-dispatched
 * to those backspace-at-block-start semantics instead of being flattened
 * into a raw text merge.
 */
const RANGE_DELETE_INPUT_TYPES: Record<string, "forward" | "backward"> = {
    deleteContentForward: "forward",
    deleteWordForward: "forward",
    deleteSoftLineForward: "forward",
    deleteHardLineForward: "forward",
    deleteWordBackward: "backward",
    deleteSoftLineBackward: "backward",
    deleteHardLineBackward: "backward",
    deleteEntireSoftLine: "backward",
};

export type EditorProps = {
    textAreaDom: HTMLDivElement;
    editorStore: EditorStore;
};

export class EditorController {
    private _textAreaDom_: HTMLDivElement;

    private _parentMap_: WeakMap<
        RenderData | ParentRenderData,
        ParentRenderData
    >;

    private _editorStore_: EditorStore;

    private _parentMapEffectCleanup_: () => void;

    constructor({ textAreaDom, editorStore }: EditorProps) {
        this._textAreaDom_ = textAreaDom;
        this._editorStore_ = editorStore;
        this._parentMap_ = new WeakMap();

        this.updateParentMap_();
        // addEffect returns an unsubscribe and destroy_ calls it. The original
        // implementation never unsubscribed, so the old subscription leaked under
        // StrictMode's double instantiation (called out in refe-412771).
        this._parentMapEffectCleanup_ = addEffect(editorStore, () => {
            this.updateParentMap_();
        }, [(state) => state.renderData_]);
    }

    public get textAreaDom_() {
        return this._textAreaDom_;
    }

    private get parentMap_() {
        return this._parentMap_;
    }

    public updateParentMap_() {
        const stack: (ParentRenderData | RenderData)[] = [
            this._editorStore_.renderData_,
        ];
        while (stack.length) {
            const node = stack.pop();

            if (node?.children_) {
                // Push children to the stack in reverse order to maintain the correct processing order
                for (let i = node.children_.length - 1; i >= 0; i--) {
                    this.parentMap_.set(node.children_[i], node);
                    stack.push(node.children_[i]);
                }
            }
        }
    }

    /** Drop DOM focus if the editor (or a descendant) currently holds it —
     *  the render layer calls this when store.blur() bumps blurRequest_. The
     *  real blur event then runs the normal chain: handleBlur_ commits
     *  pending text and closes the awareness gate, and host-level cursor
     *  overlays hide. A no-op when the editor is not focused (the store has
     *  already applied the model-side effects itself). */
    public blur() {
        const active = document.activeElement;
        if (
            active instanceof HTMLElement &&
            (active === this._textAreaDom_ ||
                this._textAreaDom_.contains(active))
        ) {
            active.blur();
        }
    }

    public focus() {
        // preventScroll: a programmatic focus() on an unfocused editor would
        // otherwise scroll-into-view the WHOLE contenteditable root — the
        // browser aligns its top edge, i.e. yanks the viewport to the top of
        // the document. Focus restores input capability only; where the
        // viewport sits is owned by the user (and the scroll-memory anchor).
        this._textAreaDom_.focus({ preventScroll: true });
        // focus() means "restore input focus", and it must **never destroy a live
        // selection the user is holding**. The host app's "click the blank area to
        // focus" callback fires for two gestures with opposite intent; tell them
        // apart by the state of the DOM selection at click time (both orderings
        // confirmed by black-box experiment):
        // - A drag-selection whose end point falls outside the editor → the click
        //   from that mouseup calls this method by accident, and at that instant the
        //   DOM selection is **still alive** (the drag established it, mouseup does
        //   not clear it) → do not write the cursor: the DOM is the truth, and the
        //   debounced selectionchange sync will bring the store into line.
        //   Collapsing unconditionally, as we used to, killed the selection the user
        //   had just dragged ("the selection disappears when you drag out of the
        //   editor" had its root cause here).
        // - Clicking the blank area to dismiss an existing selection → Chrome has
        //   already cleared the DOM selection natively on mousedown (the "flash" the
        //   user sees), so at click time there is no live selection inside the editor
        //   → fall through to the collapse-restore below: the caret returns to the
        //   start of the selection (the pre-existing dismiss behavior). Replaying the
        //   store's start+end here instead would resurrect the very selection the
        //   user just dismissed.
        const selection = document.getSelection();
        if (
            selection &&
            selection.rangeCount > 0 &&
            !selection.isCollapsed &&
            this._textAreaDom_.contains(selection.anchorNode)
        ) {
            return;
        }
        const startCursorInfo = this._editorStore_.startCursorInfo;
        if (!startCursorInfo) {
            const cursorInfo = getCursorInfoByParseData(
                this._editorStore_.state.renderData_.children_.at(-1),
            );
            this._editorStore_.setCursorInfo_(cursorInfo, null, CursorSource.Model);
        } else {
            this._editorStore_.setCursorInfo_({ ...startCursorInfo }, null, CursorSource.Model);
        }
    }

    public getParent_(
        parsedData: ParentRenderData | RenderData,
        levelsUp: number = 1,
    ) {
        let node: ParentRenderData | RenderData | undefined = parsedData;
        for (let i = 0; i < levelsUp && node; i++) {
            node = this.parentMap_.get(node);
        }
        return node as ParentRenderData | undefined;
    }

    /**
     * Delete at the current cursor position, including any selected text.
     * @returns
     */
    public deleteInCursor_() {
        // Select-all terminal state: DOM coordinates cannot address the leading /
        // trailing serialization scaffolding (deleting through them leaves stubs
        // behind) nor the still-unparsed part of a chunked load, so clear the whole
        // document outright.
        if (this._editorStore_.cursorInfo_.all_) {
            this._editorStore_.replaceAllContent_("");
            return;
        }
        if (this._editorStore_.activeAtomicUUID_) {
            this._editorStore_.chainProduceParsedData_((chain) => {
                chain.moveCursorToSibling_(
                    this._editorStore_.activeAtomicUUID_!,
                );
                chain.removeFromParent_(this._editorStore_.activeAtomicUUID_!);
            });
            this._editorStore_.setActiveAtomicUUID_(null);
            return;
        }
        const cursorInfo = getCursorInfo();

        if (!cursorInfo.length) return;

        const deleteByCursorInfo = (cursorInfo: {
            offset: number;
            renderElement: HTMLElement;
            renderUUID: string;
            commonAncestorContainer: Node;
        }) => {
            const { renderElement, renderUUID, offset } = cursorInfo;
            let index = offset;
            const renderData = getRenderDataById(
                renderUUID,
                this._editorStore_.renderData_,
            ) as ParentRenderData;
            if (!renderData) return;

            const parentNodeData = this.getParent_(renderData, 1);
            // Index within the parent element
            let renderIndex =
                parentNodeData?.children_.findIndex((c) => c === renderData) ??
                -1;
            const renderText = getVisibleDomText(renderElement) || "";
            if (!parentNodeData) return;

            // Backspace in rich mode: symbols are never visible → tunnel to the
            // nearest visible character / emptying a construct dissolves it together
            // with its symbol pair / an atomic construct (an image) is deleted whole
            // / backspace at the start of a heading demotes it to a paragraph. Code
            // blocks are excluded (no inline symbols, plus their own ZWSP / newline
            // special cases). See reference/rich-text-mode-research.md Phase 3.
            if (
                this._editorStore_.mode === "rich" &&
                index > 0 &&
                renderData.htmlType_ !== MarkdownType.PreCode &&
                renderData.htmlType_ !== MarkdownType.PreCodeEmpty
            ) {
                const plan = planRichBackspace(
                    renderData,
                    renderText,
                    index,
                );
                if (plan.kind_ === "text") {
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.resetTextByUUID_(renderUUID, plan.text_);
                    });
                    this._editorStore_.setPendingInput_(null);
                    this._editorStore_.updatePaddingMdSybolsAfterRender_();
                    return;
                }
                if (plan.kind_ === "blockStart") {
                    // Visually at the start of the block (no visible character
                    // before the hidden symbols): fall through to the existing
                    // index === 0 semantics (merge / outdent), formatting preserved
                    index = 0;
                }
            }

            if (renderData.htmlType_ === MarkdownType.PreCodeEmpty) {
                // A code area that had content: backspacing again once the last
                // character has been deleted
                this._editorStore_.chainProduceParsedData_((chain) => {
                    chain
                        .addEmptyPToNext_(parentNodeData.uuid_, true)
                        .removeFromParent_(parentNodeData.uuid_);
                });
            } else if (renderData.htmlType_ === MarkdownType.PreCode) {
                if (
                    index === 0 &&
                    getVisibleDomText(renderElement) === ZeroWidthSpace
                ) {
                    // Caret at position 0 of the code area and the code area has
                    // no other characters
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain
                            .addEmptyPToNext_(parentNodeData.uuid_, true)
                            .removeFromParent_(parentNodeData.uuid_);
                    });
                } else if (index !== 0) {
                    // Caret somewhere else in the code area
                    const codeText = toMarkdown(parentNodeData);
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        const text = TextOperator.of(renderText)
                            .deleteBackward(index, { markCursor: true })
                            // Code-block dialect: append a ZWSP when the sentinel
                            // is alone on a line, otherwise that line has no content
                            // box and the caret cannot be painted
                            .when(
                                (op) => op.equals(CursorMarker) || op.endsWith(`\n${CursorMarker}`),
                                (op) => op.append(ZeroWidthSpace),
                            )
                            .text;
                        const newText = codeText.replace(renderText, text);
                        chain.resetTextByUUID_(parentNodeData.uuid_, newText);
                    });
                }
            } else if (
                parentNodeData?.htmlType_ === MarkdownType.Blockquote &&
                index === 0
            ) {
                const liIndex = parentNodeData.children_.findIndex(
                    (c) => c === renderData,
                );
                if (liIndex === 0 && renderIndex === 0) {
                    // Caret at offset 0 of the first child of the first li
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.moveChildrenToParentPreSibling_(renderData.uuid_);
                    });
                } else if (renderIndex !== 0) {
                    // Caret on a non-first child of the li, at offset 0 of that
                    // child paragraph
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain
                            .moveToPreSiblingLastRender_(renderUUID, true)
                            .removeFromParent_(renderUUID);
                    });
                } else if (renderIndex === 0) {
                    // Caret at offset 0 of the li's first child
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.moveChildrenToPreSibling_(parentNodeData.uuid_);
                    });
                }
            } else if (
                (parentNodeData?.htmlType_ === MarkdownType.li ||
                    parentNodeData?.htmlType_ === MarkdownType.CheckBoxLi) &&
                index === 0
            ) {
                // index === 0 means the caret sits at offset 0 of the render node.
                // renderIndex here is which child of the li the render node is,
                // usually the first one.
                const ulNodeData = this.getParent_(parentNodeData, 1);
                if (parentNodeData?.htmlType_ === MarkdownType.CheckBoxLi) {
                    renderIndex -= 1;
                }
                if (ulNodeData) {
                    const liIndex = ulNodeData.children_.findIndex(
                        (c) => c === parentNodeData,
                    );
                    if (liIndex === 0 && renderIndex === 0) {
                        // Caret at offset 0 of the first child of the first li
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.moveChildrenToParentPreSibling_(
                                parentNodeData.uuid_,
                            );
                        });
                    } else if (renderIndex !== 0) {
                        // Caret on a non-first child of the li, at offset 0 of
                        // that child paragraph
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain
                                .moveToPreSiblingLastRender_(renderUUID, true)
                                .removeFromParent_(renderUUID);
                        });
                    } else if (renderIndex === 0) {
                        // Caret at offset 0 of the li's first child
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.moveChildrenToPreSibling_(
                                parentNodeData.uuid_,
                            );
                        });
                    }
                }
            } else if (renderText) {
                const preSlibling =
                    renderIndex > 0
                        ? parentNodeData.children_[renderIndex - 2]
                        : null;
                if (
                    index === 0 &&
                    preSlibling?.htmlType_ === MarkdownType.HrDiv
                ) {
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        const brData =
                            parentNodeData.children_[renderIndex - 1];
                        chain.moveCursorToSibling_(preSlibling.uuid_!);
                        chain
                            .removeFromParent_(brData.uuid_)
                            .removeFromParent_(preSlibling.uuid_);
                    });
                } else if (index === 0) {
                    // Plain paragraph, has content, caret at the very start
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.moveToPreSiblingLastRender_(renderUUID, true);
                    });
                } else {
                    // Plain paragraph, has content, caret not at the start:
                    // an ordinary delete
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        const text = TextOperator.of(renderText).deleteBackward(index, { markCursor: true }).text;
                        chain.resetTextByUUID_(renderUUID, text);
                    });
                    this._editorStore_.setPendingInput_(null);
                }
            } else if (!renderText && parentNodeData.children_.length > 1) {
                // Caret sits in an empty paragraph with no text
                const preSlibling =
                    renderIndex > 0
                        ? parentNodeData.children_[renderIndex - 1]
                        : null;
                if (
                    preSlibling?.htmlType_ === MarkdownType.LineBr ||
                    preSlibling?.htmlType_ === MarkdownType.LineBrBr
                ) {
                    const prePreSibling =
                        parentNodeData.children_[renderIndex - 2];
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain
                            .moveCursorToSibling_(preSlibling.uuid_)
                            .removeFromParent_(renderUUID)
                            .removeFromParent_(preSlibling.uuid_);
                    });
                    if (prePreSibling?.htmlType_ === MarkdownType.HrDiv) {
                        // The previous element is an HrDiv
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.moveCursorToSibling_(prePreSibling.uuid_!);
                            chain.removeFromParent_(prePreSibling.uuid_);
                        });
                    }
                } else if (preSlibling?.htmlType_ === MarkdownType.HrDiv) {
                    // The previous element is an HrDiv
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.moveCursorToSibling_(preSlibling.uuid_!);
                        chain.removeFromParent_(preSlibling.uuid_);
                    });
                } else {
                    // The previous element is not an HrDiv
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain
                            .moveCursorToNextSibling_(renderUUID)
                            .removeFromParent_(renderUUID);
                    });
                }
            } else if (!renderText && parentNodeData.children_.length === 0) {
                const grandParentData = this.getParent_(parentNodeData, 1);
                if (grandParentData && grandParentData.children_.length > 1) {
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.removeFromParent_(parentNodeData?.uuid_);
                    });
                }
            }
        };

        switch (cursorInfo.length) {
            case 1: {
                deleteByCursorInfo(cursorInfo[0]);
                break;
            }
            case 2: {
                this._editorStore_.chainProduceParsedData_((chain) => {
                    if (
                        this._editorStore_.startCursorInfo &&
                        this._editorStore_.endCursorInfo_
                    ) {
                        chain.deleteSelect_([
                            this._editorStore_.startCursorInfo,
                            this._editorStore_.endCursorInfo_,
                        ]);
                    }
                });
                break;
            }
        }

        this._editorStore_.updatePaddingMdSybolsAfterRender_();
    }

    /**
     * Range-mechanism deletes: every delete* inputType in
     * RANGE_DELETE_INPUT_TYPES lands here — forward (fn+Delete / Ctrl+D /
     * Ctrl+K / Option+fn+Delete) and backward line/word deletes
     * (Cmd+Delete / Option+Delete / Ctrl+U) alike. Left native, the
     * browser would rewrite the DOM behind the data layer's back, and the
     * reparse fallback (parseInCursor_) only re-reads the caret's block —
     * a block swallowed by a cross-block delete would survive in the model
     * and be resurrected on the next render: duplicated content and a
     * diverged undo history (issue #21).
     *
     * The takeover is one mechanism, not per-key semantics: beforeinput's
     * getTargetRanges() already carries exactly the stretch the engine meant
     * to delete (grapheme clusters, word and line boundaries included), so
     * map that range's endpoints to model coordinates and run the existing
     * selection-delete pipeline. A caret at the end of a block degrades
     * naturally to "merge the next block up" — the mirror image of backspace
     * at the start of a block.
     */
    private deleteRangeInCursor_(
        e: InputEvent,
        direction: "forward" | "backward",
    ) {
        // Selection-shaped states delete the selection itself, exactly like
        // plain backspace — reuse its dispatch (select-all terminal state,
        // an active atomic block, a two-endpoint DOM selection).
        if (
            this._editorStore_.cursorInfo_.all_ ||
            this._editorStore_.activeAtomicUUID_ ||
            getCursorInfo().length === 2
        ) {
            this.deleteInCursor_();
            return;
        }
        // Collapsed caret: address the engine-computed deletion range. No
        // range, or a collapsed one, means nothing to delete (the edge of
        // the document).
        const targetRange = e.getTargetRanges()[0];
        if (!targetRange || targetRange.collapsed) return;
        // StaticRange → live Range: the shared endpoint mapper measures with
        // Range APIs. setStart/setEnd throw on detached nodes — then drop
        // the edit (we already preventDefault-ed; a dead key beats a native
        // DOM mutation the model never hears about).
        const range = document.createRange();
        try {
            range.setStart(
                targetRange.startContainer,
                targetRange.startOffset,
            );
            range.setEnd(targetRange.endContainer, targetRange.endOffset);
        } catch {
            return;
        }
        const cursorInfo = getCursorInfoOfRange(range);
        // An endpoint outside any render element (serialization scaffolding,
        // a view-only decoration): fail safe, same rationale as above.
        if (cursorInfo.length !== 2) return;
        // A backward range that crosses into the previous block means the
        // caret sits at the visible start of its block (Cmd+Delete /
        // Option+Delete at block start). That position already has a
        // structural owner — backspace-at-block-start semantics in
        // deleteInCursor_ (list outdent, blockquote dissolve, heading
        // demotion) — so re-dispatch there instead of flattening the merge
        // into a raw text-level reparse.
        if (
            direction === "backward" &&
            cursorInfo[0].renderUUID !== cursorInfo[1].renderUUID
        ) {
            this.deleteInCursor_();
            return;
        }
        this._editorStore_.chainProduceParsedData_((chain) => {
            chain.replaceSelect_(cursorInfo.map(this.adjustCursor_), "");
        });
        this._editorStore_.setPendingInput_(null);
        this._editorStore_.updatePaddingMdSybolsAfterRender_();
    }

    /**
     * Selection replace: delete the current selection's content and insert `text` at
     * the deletion point, leaving the caret after `text`.
     * Used for "typing a character while a selection exists" — the browser would only
     * replace the selection in the DOM, so the other blocks in the data layer would
     * survive and the character would land in the end block. The delete and the
     * insert must happen atomically inside one produce; never rely on the
     * intermediate DOM.
     */
    public replaceSelect_(text: string) {
        // Select-all terminal state: replace the whole document (native select-all
        // usually puts the DOM endpoints on the root container, so getCursorInfo's
        // coordinates are unreliable to begin with).
        if (this._editorStore_.cursorInfo_.all_) {
            this._editorStore_.replaceAllContent_(text);
            return;
        }
        const cursorInfo = getCursorInfo();
        if (cursorInfo.length !== 2) return;
        this._editorStore_.chainProduceParsedData_((chain) => {
            chain.replaceSelect_(cursorInfo.map(this.adjustCursor_), text);
        });
        this._editorStore_.setPendingInput_(null);
        this._editorStore_.updatePaddingMdSybolsAfterRender_();
    }

    public adjustCursor_ = (cursor: {
        offset: number;
        renderElement: HTMLElement;
        renderUUID: string;
        commonAncestorContainer: Node;
    }) => {
        const node = getRenderDataById(
            cursor.renderUUID,
            this._editorStore_.renderData_,
        ) as ParentRenderData;
        const { curNode: parseNode } = getNodeInfo(cursor.offset, node);
        if (
            parseNode?.mdSymbols_.length &&
            parseNode?.mdSymbols_[0] === parseNode.uuid_ &&
            cursor.offset === parseNode.text_.length
        ) {
            return {
                uuid: cursor.renderUUID,
                offset: 0,
            };
        } else if (parseNode?.mdSymbols_.length) {
            const { curNode: nextNode } = getNodeInfo(cursor.offset + 1, node);
            if (
                nextNode?.mdSymbols_.length &&
                nextNode?.mdSymbols_[1] === nextNode.uuid_ &&
                cursor.offset + nextNode.text_.length ===
                getVisibleDomText(cursor.renderElement)?.length
            ) {
                return {
                    uuid: cursor.renderUUID,
                    offset: cursor.offset + nextNode.text_.length,
                };
            }
        } else if (parseNode && cursor.offset === 0) {
            const parentLiNodeData = this.getParent_(parseNode, 2);
            if (
                parentLiNodeData &&
                parentLiNodeData.htmlType_ === MarkdownType.li
            ) {
                const parentNodeData = this.getParent_(parentLiNodeData, 1);
                if (
                    parentNodeData?.children_[0].uuid_ ===
                    parentLiNodeData.uuid_
                ) {
                    const dom = this.textAreaDom_.querySelector(
                        `[data-render-id="${parentNodeData.uuid_}"]`,
                    );
                    if (dom) {
                        return {
                            offset: 0,
                            uuid: parentNodeData.uuid_,
                        };
                    }
                }
            }
        }
        return {
            uuid: cursor.renderUUID,
            offset: cursor.offset,
        };
    };

    /**
     * Shift+Enter soft break: literally insert a "\n" at the cursor, reusing the one
     * insertText pipeline (a selection is deleted first), with no context-specific
     * special casing — the semantics are left to the reparse:
     * - Mid-paragraph: a soft break within the same paragraph (P is pre-wrap, so \n
     *   renders as a line break directly);
     * - End of an li: `- x\n` hits parseUL autofill → the next li item appears;
     * - Mid-li / heading / blockquote: the \n splits the block in two, per literal
     *   markdown semantics;
     * - Code block: a new line.
     * The one guard is table cells: a markdown table row cannot hold a literal \n
     * (serializing splits the row, and reparsing the document shatters the table), so
     * this is a no-op there, consistent with Enter.
     */
    public handleSoftBreakInCursor_() {
        // Select-all terminal state: skip the DOM-coordinate guards (the endpoints
        // may sit on the root container) and go straight to insertText's
        // whole-document replace branch.
        if (this._editorStore_.cursorInfo_.all_) {
            this._editorStore_.insertText("\n");
            return;
        }
        const cursorInfo = getCursorInfo();
        if (!cursorInfo.length) return;

        const renderData = getRenderDataById(
            cursorInfo[0].renderUUID,
            this._editorStore_.renderData_,
        ) as ParentRenderData;
        if (!renderData) return;
        const parentNodeData = this.getParent_(renderData, 1);
        if (
            parentNodeData?.htmlType_ === MarkdownType.TH ||
            parentNodeData?.htmlType_ === MarkdownType.TD
        ) {
            return;
        }

        // insertText takes its context from the serialized model, so commit the
        // speculatively rendered pending text first
        this._editorStore_.applyPendingText_();
        this._editorStore_.insertText("\n");
    }

    public handleEnterInCursor_(commandKey: boolean) {
        // Select-all terminal state: Enter = replace the whole document with a
        // single newline (the same semantics as native contenteditable: delete the
        // selection + break the paragraph → an empty paragraph with the caret in the
        // last one).
        if (this._editorStore_.cursorInfo_.all_) {
            this._editorStore_.replaceAllContent_("\n");
            return;
        }
        const cursorInfo = getCursorInfo();
        if (!cursorInfo.length) return;

        switch (cursorInfo.length) {
            case 1: {
                const { renderElement, renderUUID, offset } = cursorInfo[0];
                let index = offset;
                const renderData = getRenderDataById(
                    renderUUID,
                    this._editorStore_.renderData_,
                ) as ParentRenderData;
                if (!renderData) return;

                // Block-split affinity in rich mode = outside: an Enter at the tail
                // of a construct (`bold|**`) is normalized to sit after the construct
                // before splitting, so a line break never pushes syntax symbols onto
                // the next line. Typing affinity is the opposite (inside, so
                // formatting continues); normalization is wired only into
                // block-splitting operations, through a single function
                // (normalizeRichCursorOffset). The mode gate is a deliberate
                // behavioral difference: markdown mode edits the literal source,
                // where splitting a syntax literal with Enter is a legitimate
                // operation.
                if (
                    this._editorStore_.mode === "rich" &&
                    renderData.htmlType_ !== MarkdownType.PreCode &&
                    renderData.htmlType_ !== MarkdownType.PreCodeEmpty &&
                    renderData.htmlType_ !== MarkdownType.PreEmpty &&
                    isModelDomInSync(renderData, renderElement)
                ) {
                    index = normalizeRichCursorOffset(renderData, index);
                }

                const parentNodeData = this.getParent_(renderData, 1);

                if (
                    parentNodeData?.htmlType_ === MarkdownType.TH ||
                    parentNodeData?.htmlType_ === MarkdownType.TD
                ) {
                    // Enter typed inside a table cell
                } else if (renderData.htmlType_ === MarkdownType.PreEmpty) {
                    // Enter typed right after a ``` fence opener
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        const text = TextOperator.of(getVisibleDomText(renderElement)).insert(
                            index,
                            `\n${CursorMarker}${ZeroWidthSpace}` + "\n```\n\n",
                        ).text;
                        chain.resetTextByUUID_(renderUUID, text);
                    });
                    this._editorStore_.setPendingInput_(null);
                } else if (renderData.htmlType_ === MarkdownType.PreCode) {
                    const preData = this.getParent_(renderData, 1);
                    const mark = `console.log(${CursorMarker})`;
                    let codeText = getVisibleDomText(renderElement) || "";
                    if (codeText.length === index && commandKey && preData) {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.addNextByUUID_(preData.uuid_, CursorMarker);
                        });
                        this._editorStore_.setPendingInput_(null);
                        this._editorStore_.updatePaddingMdSybolsAfterRender_();
                    } else {
                        codeText = codeText.replaceAll(ZeroWidthSpace, "");
                        codeText =
                            codeText.slice(0, index) +
                            "\n" +
                            mark +
                            codeText.slice(index);

                        // Code beautify: injected by the caller (e.g. js-beautify);
                        // the core depends on no particular implementation. `lang`
                        // comes from the fence's first line ```lang; returning
                        // undefined means there is no beautifier for that language.
                        const codeBeautify =
                            this._editorStore_.codeBeautify_;
                        if (codeBeautify) {
                            const lang = (
                                preData?.children_[0]?.text_ || ""
                            )
                                .replaceAll(ZeroWidthSpace, "")
                                .replace("```", "")
                                .trim();
                            const beautified = codeBeautify(
                                codeText,
                                lang || undefined,
                            );
                            // Guard: the cursor-marker statement must appear in the
                            // beautified output exactly once and intact; otherwise
                            // (the beautifier rewrote or swallowed the marker) drop
                            // this beautify pass so the cursor can never be lost.
                            if (
                                typeof beautified === "string" &&
                                beautified.indexOf(mark) !== -1 &&
                                beautified.indexOf(mark) ===
                                beautified.lastIndexOf(mark)
                            ) {
                                codeText = beautified;
                            }
                        }

                        codeText = codeText.replace(
                            mark,
                            CursorMarker + ZeroWidthSpace,
                        );
                        const text =
                            preData?.children_[0].text_ +
                            "\n" +
                            codeText +
                            "\n```";

                        if (preData?.uuid_) {
                            this._editorStore_.chainProduceParsedData_(
                                (chain) => {
                                    chain.resetTextByUUID_(preData.uuid_, text);
                                },
                            );
                            this._editorStore_.setPendingInput_(null);
                            this._editorStore_.updatePaddingMdSybolsAfterRender_();
                        }
                    }
                } else if (
                    parentNodeData?.htmlType_ === MarkdownType.li ||
                    parentNodeData?.htmlType_ === MarkdownType.CheckBoxLi
                ) {
                    // Enter typed inside an li: parentNodeData is the li, and
                    // renderDataIndex is which child of the li the render node is
                    let renderDataIndex = parentNodeData.children_.findIndex(
                        (c) => c === renderData,
                    );
                    if (parentNodeData.htmlType_ === MarkdownType.CheckBoxLi) {
                        renderDataIndex -= 1;
                    }
                    if (getVisibleDomText(renderElement) === "") {
                        // grandParentData is the OL or the UL
                        const grandParentData = this.getParent_(
                            parentNodeData,
                            1,
                        );
                        if (grandParentData) {
                            if (renderDataIndex === 0) {
                                // todo: the logic is still incomplete; for now it
                                // mainly handles a trailing empty li well.
                                // The render node is empty and is the li's first
                                // child (the head node).
                                this._editorStore_.chainProduceParsedData_(
                                    (chain) => {
                                        chain
                                            .removeFromParent_(
                                                parentNodeData.uuid_,
                                            )
                                            .addEmptyPToNext_(
                                                grandParentData.uuid_,
                                                true,
                                            );
                                    },
                                );
                            } else {
                                // The render node is empty and clearly is not the
                                // li's first child: delete this line and add a new
                                // li to the UI
                                this._editorStore_.chainProduceParsedData_(
                                    (chain) => {
                                        chain
                                            .removeFromParent_(renderData.uuid_)
                                            .addNextEmptySiblingByUUID_(
                                                parentNodeData.uuid_,
                                                true,
                                            );
                                    },
                                );
                            }
                        }
                    } else {
                        if (renderDataIndex === 0) {
                            this._editorStore_.applyPendingText_();
                            // On the li's first child and there is text: Enter
                            // moves everything from the caret onward into a brand
                            // new li
                            this._editorStore_.chainProduceParsedData_(
                                (chain) => {
                                    let text = toMarkdown(parentNodeData);
                                    if (
                                        text.startsWith(`[ ] `) ||
                                        text.startsWith(`[x] `)
                                    ) {
                                        text = text.slice(4);
                                    }
                                    // debugger;
                                    // const text =
                                    //     getVisibleDomText(renderElement) || "";
                                    const newFirstLineText = text.slice(
                                        0,
                                        index,
                                    );
                                    const newNextSiblingText =
                                        CursorMarker + text.slice(index);

                                    chain
                                        .resetTextByUUID_(
                                            renderUUID,
                                            newFirstLineText,
                                        )
                                        .addNextSiblingByUUID_(
                                            parentNodeData.uuid_,
                                            newNextSiblingText,
                                        )
                                        .moveNonFirstLiChildrenToNextLi_(
                                            parentNodeData.uuid_,
                                        );
                                },
                            );
                        } else {
                            this._editorStore_.chainProduceParsedData_(
                                (chain) => {
                                    const text =
                                        getVisibleDomText(renderElement) || "";
                                    const newText = text.slice(0, index);
                                    const newNextSiblingText =
                                        CursorMarker + text.slice(index);
                                    chain
                                        .addNextByUUID_(
                                            renderUUID,
                                            newNextSiblingText,
                                        )
                                        .resetTextByUUID_(renderUUID, newText);
                                },
                            );
                        }
                        this._editorStore_.setPendingInput_(null);
                    }
                } else if (parentNodeData?.htmlType_ === MarkdownType.Detail) {
                    let renderDataIndex = parentNodeData.children_.findIndex(
                        (c) => c === renderData,
                    );

                    if (getVisibleDomText(renderElement) === "") {
                        const grandParentData = this.getParent_(
                            parentNodeData,
                            1,
                        );
                        if (grandParentData) {
                            if (renderDataIndex === 0) {
                                // this._rootStore.renderDataStore.cahinProduceParsedData(chain => {
                                //   chain.removeFromParent(parentNodeData.uuid)
                                //     .addEmptyPToNext(grandParentData.uuid, true, (cursorInfo) => {
                                //       this._rootStore.editorStateStore.setStartCursorInfo(cursorInfo);
                                //     })
                                // })
                            } else {
                                this._editorStore_.chainProduceParsedData_(
                                    (chain) => {
                                        chain
                                            .removeFromParent_(renderData.uuid_)
                                            .addEmptyPToNext_(
                                                parentNodeData.uuid_,
                                                true,
                                            );
                                    },
                                );
                            }
                        }
                    } else {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            const text = getVisibleDomText(renderElement) || "";
                            const newText = text.slice(0, index);
                            const newNextSiblingText =
                                CursorMarker + text.slice(index);
                            chain
                                .addNextByUUID_(renderUUID, newNextSiblingText)
                                .resetTextByUUID_(renderUUID, newText);
                        });
                        this._editorStore_.setPendingInput_(null);
                    }
                } else if (
                    parentNodeData?.htmlType_ === MarkdownType.Blockquote &&
                    getVisibleDomText(renderElement) === ""
                ) {
                    const grandParentData = this.getParent_(parentNodeData, 1);
                    if (grandParentData) {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain
                                .removeFromParent_(renderData.uuid_)
                                .addEmptyPToNext_(parentNodeData.uuid_, true);
                        });
                    }
                } else if (
                    // This condition could be dropped and the case handled as a
                    // plain P paragraph
                    parentNodeData &&
                    getVisibleDomText(renderElement) === "---"
                ) {
                    const renderDataIndex = parentNodeData.children_.findIndex(
                        (c) => c === renderData,
                    );
                    if (
                        renderDataIndex ===
                        parentNodeData.children_.length - 1
                    ) {
                        // Create a new paragraph
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            const text = TextOperator.of(
                                getVisibleDomText(renderElement) || "",
                            ).insert(index, "\n\n" + CursorMarker).text;
                            chain.resetTextByUUID_(renderUUID, text);
                        });
                    } else {
                        // No new paragraph; move the caret into the next paragraph
                        const nextSibling =
                            parentNodeData.children_[renderDataIndex + 1];
                        const nextText = toMarkdown(nextSibling);
                        const newText =
                            (getVisibleDomText(renderElement) || "") +
                            "\n\n" +
                            CursorMarker +
                            nextText;
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain
                                .removeFromParent_(nextSibling.uuid_)
                                .resetTextByUUID_(renderUUID, newText);
                        });
                    }
                } else {
                    // Plain P paragraph
                    if (getVisibleDomText(renderElement) === "") {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.addEmptyPToNext_(renderUUID, true);
                        });
                    } else if (index === 0) {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain
                                .addEmptyPToPre_(renderUUID, false)
                                .setStartCursorInfo_({
                                    uuid: renderUUID,
                                    offset: 0,
                                });
                        });
                    } else {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            const text = TextOperator.of(
                                getVisibleDomText(renderElement) || "",
                            ).insert(index, "\n\n" + CursorMarker).text;
                            chain.resetTextByUUID_(renderUUID, text);
                        });
                    }
                    this._editorStore_.setPendingInput_(null);
                }
                break;
            }
            case 2: {
                this.deleteInCursor_();
                break;
            }
        }
    }

    public handleTabInCursor_() {
        const cursorInfo = getCursorInfo();
        if (!cursorInfo.length) return;

        switch (cursorInfo.length) {
            case 1: {
                const {
                    renderElement,
                    renderUUID,
                    offset: index,
                } = cursorInfo[0];
                const renderData = getRenderDataById(
                    renderUUID,
                    this._editorStore_.renderData_,
                ) as ParentRenderData;
                if (!renderData) return;

                const parentNodeData = this.getParent_(renderData, 1);
                if (
                    parentNodeData?.htmlType_ === MarkdownType.li ||
                    parentNodeData?.htmlType_ === MarkdownType.CheckBoxLi
                ) {
                    const grandparentData = this.getParent_(parentNodeData, 1); //ul/ol;
                    if (!grandparentData) return;
                    const liDataIndex = grandparentData.children_.findIndex(
                        (c) => c === parentNodeData,
                    );
                    if (liDataIndex !== 0) {
                        let newText =
                            (getVisibleDomText(renderElement) || "") + CursorMarker;

                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.resetTextByUUID_(renderUUID, newText);
                            //chain.liToPreSiblingChild(parentNodeData.uuid, true)
                            chain.liToPreSiblingChild_(parentNodeData.uuid_);
                        });
                    }
                    this._editorStore_.setPendingInput_(null);
                }
                break;
            }
            case 2: {
                this.deleteInCursor_();
                break;
            }
        }
    }

    /**
     * Parse the text that has already landed in the DOM.
     * @returns
     */
    public parseInCursor_() {
        const cursorInfo = getCursorInfo();
        if (!cursorInfo.length) return;

        switch (cursorInfo.length) {
            case 1: {
                const {
                    renderElement,
                    renderUUID,
                    offset: index,
                } = cursorInfo[0];
                const renderData = getRenderDataById(
                    renderUUID,
                    this._editorStore_.renderData_,
                ) as ParentRenderData;
                if (!renderData) return;

                if (renderData.htmlType_ === MarkdownType.PreCode) {
                    const preData = this.getParent_(renderData, 1);
                    const text =
                        preData?.children_[0].text_ +
                        "\n" +
                        this._editorStore_.insertCursorMarker_(
                            getVisibleDomText(renderElement) || "",
                            index,
                        ) +
                        "\n```";
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.resetTextByUUID_(preData?.uuid_!, text);
                    });
                    this._editorStore_.setPendingInput_(null);
                    this._editorStore_.updatePaddingMdSybolsAfterRender_();
                } else if (checkNeedRender(renderElement, this._editorStore_.inlineRules_?.triggerReg_ ?? null)) {
                    const parentData = this.getParent_(renderData, 1);
                    if (
                        getVisibleDomText(renderElement) === "[] " ||
                        getVisibleDomText(renderElement) === "【】 "
                    ) {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.resetTextByUUID_(
                                renderData.uuid_,
                                `- [ ] ${CursorMarker}`,
                            );
                        });
                    } else if (
                        parentData?.htmlType_ === MarkdownType.li &&
                        (getVisibleDomText(renderElement) === "[ ] " ||
                            getVisibleDomText(renderElement) === "[x] ")
                    ) {
                        // Turn the li into a checkbox item
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.resetTextByUUID_(
                                parentData.uuid_,
                                this._editorStore_.insertCursorMarker_(
                                    "- " + getVisibleDomText(renderElement) || "",
                                    index + 2,
                                ),
                            );
                        });
                    } else {
                        this._editorStore_.chainProduceParsedData_((chain) => {
                            chain.resetTextByUUID_(
                                renderUUID,
                                this._editorStore_.insertCursorMarker_(
                                    getVisibleDomText(renderElement) || "",
                                    index,
                                ),
                            );
                        });
                    }
                    this._editorStore_.setPendingInput_(null);
                    this._editorStore_.updatePaddingMdSybolsAfterRender_();
                } else {
                    // Push a snapshot at event time: uuid / text / offset are all
                    // in hand right now, so store them in store state; the flush
                    // (applyPendingText_) consumes only that state, and the store
                    // never reads the DOM. The old "mark a pendingUUID and read the
                    // DOM late, at flush time" design was the root of both
                    // resurrected stale text and the "which block the flush writes to
                    // depends on where the caret happens to be when it wakes up"
                    // race. When the block changes, commit the previous block's
                    // snapshot first — a branch that was unreachable and impossible
                    // to implement correctly in the old design (a late read can only
                    // see the block the caret is in now).
                    const prev = this._editorStore_.pendingInput_;
                    if (prev && prev.uuid_ !== renderUUID) {
                        this._editorStore_.applyPendingText_();
                    }
                    this._editorStore_.setPendingInput_({
                        uuid_: renderUUID,
                        text_: getVisibleDomText(renderElement) || "",
                        offset_: index,
                    });
                    this._editorStore_.debounceApplyPendingText_();
                }
                break;
            }
            case 2: {
                break;
            }
        }
    }

    // ======================================================================
    // Events (migrated from hooks/UseEditorEvent)
    // Handlers are always class-property arrow functions: their references are
    // stable, so add/removeEventListener pair up correctly.
    // ======================================================================

    // ======================================================================
    // View attachment protocol.
    //
    // The store is the document runtime; a controller binds one render
    // surface (the contenteditable root) to it for the duration of a view's
    // life. The store carries persistent view-state — cursorInfo_ (the
    // selection), focused_ (input focus) and scrollAnchor (the viewport) —
    // which a detach never clears and an attach re-materializes into the DOM:
    //
    //   - scroll is restored by the render layer's scroll-memory hook in its
    //     layout effect (before paint, so there is no flash at the top);
    //   - focus and the selection are restored here, right after listener
    //     binding, in restoreViewState_().
    //
    // init_/destroy_ are the two halves of that protocol: attach = bind +
    // restore, detach = unbind and NOTHING else. A host that keeps a store
    // alive across view unmounts (editor tabs, split view) gets its full
    // editing context back on every re-attach without managing any of it.
    //
    // Read-only is NOT part of this protocol: bind/unbind track the view's
    // life, never the editable flag. What each gesture means on a read-only
    // surface is owned by the listener registry below.
    // ======================================================================

    public init_() {
        this.enableListener_();
        this.restoreViewState_();
    }

    public destroy_() {
        this.disableListener_();
        this._parentMapEffectCleanup_();
    }

    /**
     * Re-materialize the store's persistent view-state into a freshly attached
     * DOM. Restoration mirrors the state the document was DETACHED in — it
     * never invents state:
     *
     * - A fresh store (no cursor yet) restores nothing; first mount is
     *   byte-for-byte the old behavior.
     * - A store that was blurred when its view went away stays blurred: no
     *   focus steal, no selection write (a blurred editor holds no visible
     *   selection, and the user's focus is elsewhere by definition).
     * - A store that was focused gets DOM focus back (preventScroll — the
     *   viewport belongs to the scroll anchor) and its full selection replayed
     *   exactly as recorded, range selections included.
     *
     * Deliberately NOT the public focus() path: focus() is the semantic of the
     * "click the blank area" gesture — it collapses a range to its start and
     * invents a caret at the last block when none exists. Restoration must do
     * neither.
     *
     * The selection replay carries no viewport command (scrollIntoView =
     * false): "where the caret is" and "where the user was looking" are
     * independent axes of view-state, each restored by its own mechanism.
     */
    private restoreViewState_() {
        if (!this._editorStore_.focused_) return;
        if (!this._editorStore_.startCursorInfo) return;
        this._textAreaDom_.focus({ preventScroll: true });
        this._replaySelection_(false);
    }

    // ======================================================================
    // Listener registry — the single admission point for gesture input.
    //
    // Every DOM listener is registered through registerListener_ with an
    // explicit read-only policy; there is no other addEventListener path in
    // this controller, so a handler cannot be wired up without deciding
    // what read-only means for it:
    //
    //   "always"   — observation gestures: they keep the store's view-state
    //                honest but never mutate the model on their own
    //                (focus/blur bookkeeping, selection sync, copy). A
    //                read-only document stays focusable, selectable and
    //                copyable — and copy serializes markdown, which is the
    //                read-only surface's whole contract.
    //   "editable" — mutation gestures: while store.isEditable is false the
    //                gate returns BEFORE the handler runs, so preventDefault
    //                is never reached and the browser's native behavior
    //                comes back by itself (text drags out of a viewer,
    //                Cmd+Z falls through to the page, a click below a code
    //                fence cannot grow an empty paragraph).
    //
    // The gate reads isEditable at EVENT time, not at bind time — that is
    // what makes setEditable() a pure state flip (hosts flip it on a live
    // instance: viewers promoted to editors, streaming surfaces unlocked
    // after load). Rebinding listener sets on the flip was rejected
    // deliberately: a half-torn-down set strands the composition state
    // machine (compositionend unbound while duringComposition_ is true
    // blocks every future flush), and tearing down mid-gesture leaves
    // whatever half the browser already performed unowned.
    //
    // Two handlers serve both classes and are registered "always" with one
    // internal wall each, documented at the wall: keydown (selection
    // gestures above the wall, editing keys below) and compositionend (the
    // state machine's closer must always run; its read-only branch closes
    // without committing).
    // ======================================================================

    private _boundListeners_: {
        target: EventTarget;
        type: string;
        listener: EventListener;
    }[] = [];

    private registerListener_(
        target: EventTarget,
        type: string,
        // Contravariant parameter type: every concrete handler
        // ((e: KeyboardEvent) => …, (e: ClipboardEvent) => …) is assignable
        // here without a cast at the registration site. The single cast
        // below re-asserts the type/event-object link in one place — the
        // same link the DOM's own addEventListener overloads encode.
        handler: (event: never) => unknown,
        when: "always" | "editable",
    ) {
        const invoke = handler as (event: Event) => unknown;
        const listener = (event: Event) => {
            if (when === "editable" && !this._editorStore_.isEditable) {
                return;
            }
            invoke(event);
        };
        target.addEventListener(type, listener);
        this._boundListeners_.push({ target, type, listener });
    }

    public enableListener_() {
        // Idempotent: a second enable over a live set is a no-op, and
        // disableListener_ removes exactly what was added.
        if (this._boundListeners_.length) return;
        const dom = this._textAreaDom_;

        // Observation gestures — live on read-only surfaces too.
        this.registerListener_(dom, "keydown", this.handleKeyDown_, "always");
        this.registerListener_(
            dom,
            "compositionend",
            this.handleCompositionEnd_,
            "always",
        );
        this.registerListener_(dom, "copy", this.handleCopy_, "always");
        this.registerListener_(dom, "blur", this.handleBlur_, "always");
        this.registerListener_(dom, "focus", this.handleFocus_, "always");
        this.registerListener_(
            document,
            "selectionchange",
            this.handleSelectionChange_,
            "always",
        );

        // Mutation gestures — inert while the store is read-only.
        this.registerListener_(
            dom,
            "keypress",
            this.handleKeyPress_,
            "editable",
        );
        this.registerListener_(dom, "keyup", this.handleKeyUp_, "editable");
        this.registerListener_(
            dom,
            "mousedown",
            this.handleMouseDown_,
            "editable",
        );
        this.registerListener_(dom, "click", this.handleClick_, "editable");
        this.registerListener_(
            dom,
            "compositionstart",
            this.handleCompositionStart_,
            "editable",
        );
        this.registerListener_(
            dom,
            "compositionupdate",
            this.handleCompositionUpdate_,
            "editable",
        );
        this.registerListener_(
            dom,
            "beforeinput",
            this.handleBeforeInput_,
            "editable",
        );
        this.registerListener_(dom, "input", this.handleInput_, "editable");
        this.registerListener_(dom, "paste", this.handlePaste_, "editable");
        this.registerListener_(dom, "cut", this.handleCut_, "editable");
        this.registerListener_(dom, "drop", this.handleDrop_, "editable");
        this.registerListener_(
            dom,
            "dragstart",
            this.handleDragStart_,
            "editable",
        );
    }

    public disableListener_() {
        for (const { target, type, listener } of this._boundListeners_) {
            target.removeEventListener(type, listener);
        }
        this._boundListeners_ = [];
    }

    private handleBeforeInput_ = (e: InputEvent) => {
        if (this._editorStore_.duringComposition) return;

        // Undo/redo arriving as input events rather than a keydown Cmd/Ctrl+Z:
        // native menu bar items (macOS "Edit → Undo" walks the responder chain
        // into the WKWebView's NSUndoManager; muda's predefined Redo on
        // Windows synthesizes Ctrl+Y, which Chromium maps to historyRedo),
        // the context menu, three-finger trackpad and mobile shake-to-undo
        // gestures. Take them over: the browser's native history knows
        // nothing about the model and would mutate the DOM behind the data
        // layer's back (same policy as the keydown undo/redo path).
        if (e.inputType === "historyUndo") {
            e.preventDefault();
            this._editorStore_.undo();
            return;
        }
        if (e.inputType === "historyRedo") {
            e.preventDefault();
            this._editorStore_.redo();
            return;
        }

        // Belt-and-braces for any root-level caret that reached the input
        // stage anyway (handleClick_ repairs the click-born ones): NEVER let
        // the browser default-edit at the root layer — it writes a bare text
        // node directly under the root that no model node owns (a "root
        // ghost": visible in the DOM, absent from toMarkdown, lost on save).
        // Repair the caret, re-route a plain character through the model
        // (normalizeRootCaret_ has just written the store cursor
        // synchronously, so insertText lands at the repaired position), and
        // drop anything else. Placed after the history branches on purpose —
        // undo/redo are caret-independent and must not be swallowed.
        const rootSelection = document.getSelection();
        if (
            rootSelection &&
            rootSelection.isCollapsed &&
            rootSelection.anchorNode === this._textAreaDom_
        ) {
            e.preventDefault();
            if (
                this.normalizeRootCaret_() &&
                e.inputType === "insertText" &&
                e.data != null
            ) {
                this._editorStore_.insertText(e.data);
            }
            return;
        }

        // Inline format shortcuts (Cmd/Ctrl+B/I, strikethrough) surface as
        // beforeinput format* inputTypes in contenteditable. Take them over:
        // native formatting would wrap DOM nodes and corrupt the data layer.
        // Which chars to format comes from our own selection state, not the
        // event — adjustCursor_ maps it to serialized offsets.
        const mark = FORMAT_INPUT_TYPES[e.inputType];
        if (mark) {
            e.preventDefault();
            const cursorInfo = getCursorInfo().map((c) =>
                this.adjustCursor_(c),
            );
            this._editorStore_.format(mark, cursorInfo);
            return;
        }

        if (e.inputType === "deleteContentBackward") {
            // Fallback path only: plain Backspace on physical keyboards is
            // already taken over (preventDefault) at keydown, so it never
            // reaches here. What does: soft keyboards whose keydown is the
            // 229 sentinel, and Ctrl+H-style editing bindings that produce
            // deleteContentBackward without a Backspace key. Kept because
            // WebKit skips beforeinput entirely for no-op deletes — see the
            // keydown Backspace branch for the full rationale.
            e.preventDefault();
            this.deleteInCursor_();
        } else if (RANGE_DELETE_INPUT_TYPES[e.inputType]) {
            e.preventDefault();
            this.deleteRangeInCursor_(
                e,
                RANGE_DELETE_INPUT_TYPES[e.inputType],
            );
        } else if (e.inputType === "insertText" && e.data != null) {
            // Select-all terminal state: take over unconditionally, without
            // relying on getCursorInfo()'s DOM reading — native select-all usually
            // puts the endpoints on the root container, so the reading may not be
            // length === 2, and a missed preventDefault would let the browser
            // natively replace the entire DOM, bypassing the data layer.
            if (this._editorStore_.cursorInfo_.all_) {
                e.preventDefault();
                this._editorStore_.insertText(e.data);
                return;
            }
            const info = getCursorInfo();
            if (info.length === 2) {
                // Typing a character while a selection exists: leaving it to the
                // browser would only replace the selection in the DOM, the other
                // blocks in the data layer would not be deleted, and the character
                // would land in the end block. Take over with a controlled
                // "delete the selection + insert the character".
                e.preventDefault();
                this.replaceSelect_(e.data ?? "");
                return;
            }
            if (info.length !== 1 || !e.data) return;
            const { renderUUID: uuid, offset, renderElement } = info[0];

            // Either of two conditions triggers takeover, with the same action
            // (run the kernel's insertText, cut the browser out):
            // ① the pending format marks' anchor matches → insertText does the
            //    wrapping uniformly;
            // ② in rich mode the caret sits right after a hidden symbol → Chrome's
            //    typing-style continuation ignores the caret's DOM position and,
            //    following the style of the preceding visible character, stuffs the
            //    new character into the format element in front of it (the DOM reads
            //    back as `**boldx**` → the reparse keeps it bold), so the character
            //    must be inserted after the symbol, by model offset.
            // The decision uses a live DOM reading (to dodge the selectionchange
            // debounce race); ② additionally carries the isModelDomInSync guard —
            // while a pending input is in flight the model lags, and judging a
            // boundary against a lagging model is guaranteed to be off, so on a
            // mismatch we let the browser through (the safe default).
            const pendingHit = this._editorStore_.isPendingFormatAnchor_(
                uuid,
                offset,
            );
            const renderData = pendingHit
                ? null
                : this._editorStore_.mode === "rich"
                    ? getRenderDataById(uuid, this._editorStore_.renderData_)
                    : null;
            const richHit =
                !!renderData?.children_ &&
                isCursorAfterSymbol(renderData, offset) &&
                isModelDomInSync(renderData, renderElement);
            if (pendingHit || richHit) {
                e.preventDefault();
                this._editorStore_.insertText(e.data, { uuid, offset });
            }
        }

        /**
         * TODO(mobile-autocomplete): `insertReplacementText`
         * ---------------------------------------------------------------
         * The real driver behind mobile "autocorrect / tapping a candidate word /
         * iOS Replace…". Its semantics are to **replace a stretch of existing text**
         * (not to insert at the cursor): swap the old text in some range for the new
         * text carried by `e.data`.
         *
         * You must use `e.getTargetRanges()` to get "the range about to be replaced"
         * — never assume it equals the current selection. The correct approach:
         * preventDefault → delete the corresponding interval in the data layer per
         * targetRange → insert `e.data` there → reposition the cursor.
         *
         * Where we stand without taking it over: it falls through, the browser
         * natively rewrites the DOM across the range, and handleInput's
         * parseInCursor_ has to clean up after it — which easily scrambles the
         * structure across inline format boundaries.
         */
        // else if (e.inputType === "insertReplacementText") {

        // }

        /**
         * TODO(mobile-autocomplete): `insertParagraph` / `insertLineBreak`
         * ---------------------------------------------------------------
         * Enter on mobile. Soft keyboards often **do not emit a trustworthy keydown
         * (the 229 sentinel)**, so Enter shows up only as these two inputTypes,
         * bypasses the Enter logic in handleKeyDown, and gets natively inserted into
         * the contenteditable, polluting the data layer.
         *
         * `insertParagraph` = split the block / new paragraph (a bare Enter);
         * `insertLineBreak` = soft break (Shift+Enter and some other cases). We
         * should preventDefault here and reuse the matching branches of
         * handleEnterInCursor_ for each (keeping this consistent with the
         * newlineKey_ embed mode).
         */
        // else if (e.inputType === "insertParagraph") {}
        // else if (e.inputType === "insertLineBreak") {}


    };

    private handleInput_ = async () => {
        if (this._editorStore_.duringComposition) return;
        this.parseInCursor_();
    };

    /**
     * Build the whole-document DOM selection ourselves — the select-all
     * terminal state's DOM projection.
     * -------------------------------------------------------------------
     * Why not the engine's own SelectAll: WebKit's native command collapses
     * to the document tail when the editable root's first child is a
     * non-editable overlay (custom caret / remote-cursor layers, which hosts
     * legitimately portal into the root) — measured on WebKit 26 with a
     * minimal contenteditable; Blink is unaffected.
     * Why visible-leaf endpoints and not container boundaries: WebKit keeps
     * a container-endpoint range (selectNodeContents) as selection DATA but
     * paints no highlight for it at all — pixel-verified on the system
     * WKWebView, the user experiences "Cmd+A does nothing". Endpoints must
     * sit on text nodes for WebKit to paint, and they must be *visible* text
     * nodes: coordinates resolved blindly from the model would land inside
     * hidden syntax runs (the display:none MdSymbol "# " of a heading).
     * Blink paints either form; the visible-leaf range measures stable on
     * both engines.
     * The leaf search spans the whole document, not just the outermost
     * blocks: a terminal block without any visible text (a trailing
     * auto-fill empty paragraph, a leading blank line) must not drag both
     * endpoints down to the container-boundary fallback — that fallback is
     * exactly the shape WebKit refuses to paint, and it is reserved for
     * documents with no visible text anywhere (nothing to paint anyway).
     * Used by the Cmd/Ctrl+A keydown and by the replay pass to restore the
     * terminal state after undo / a re-render dropped the anchors.
     * The DOM write is deferred by one macrotask: WebKit keeps a selection
     * installed synchronously inside a (trusted, preventDefaulted) keydown
     * handler as DATA but never paints its highlight — the exact same range
     * re-applied outside the key event paints fine (pixel-verified on the
     * system WKWebView; Blink paints both). One task of delay stays under a
     * frame, so there is no visible unselected window.
     */
    /**
     * DOM endpoints of the whole-document selection: the first / last
     * visible text leaf across the root's render blocks, each paired with
     * the block hosting it. The blocks feed the coverage probes
     * (containsNode), the leaves feed the range built by
     * applySelectAllDom_ — both sides must come from the same computation
     * or a probe would fail against our own selection and demote the
     * terminal state.
     * A render block is a root child that carries data-render-id itself OR
     * nests it deeper: wrapper components put the id on an inner element
     * (the table's scroll container — kernel TableElement and host
     * overrides alike — issue #43: the scan used to see only direct
     * attributes, so a leading table dropped out of Cmd+A entirely).
     * Non-content scaffolding (overlay divs hosts portal into the root —
     * custom caret, remote-cursor layers) contains no data-render-id
     * anywhere, so it stays excluded, which is also why the probes cannot
     * use first/lastElementChild.
     */
    private selectAllDomEndpoints_(): {
        firstBlock: Element | null;
        lastBlock: Element | null;
        firstText: Node | null;
        lastText: Node | null;
    } {
        // The parentElement display check matches how MdSymbol hides syntax
        // (display:none directly on the leaf's parent span); checkVisibility
        // additionally covers hidden ancestors where supported.
        const isVisible = (el: Element) =>
            (el as HTMLElement).checkVisibility?.() ??
            window.getComputedStyle(el).display !== "none";
        const visibleTextIn = (scope: Element, last: boolean) => {
            const walker = document.createTreeWalker(
                scope,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (n) =>
                        n.parentElement && isVisible(n.parentElement)
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_REJECT,
                },
            );
            if (!last) return walker.nextNode();
            let found: Node | null = null;
            while (walker.nextNode()) found = walker.currentNode;
            return found;
        };
        const blocks: Element[] = [];
        for (const el of this._textAreaDom_.children) {
            if (
                !el.hasAttribute("data-render-id") &&
                !el.querySelector("[data-render-id]")
            )
                continue;
            blocks.push(el);
        }
        let firstBlock: Element | null = null;
        let firstText: Node | null = null;
        for (const block of blocks) {
            const text = visibleTextIn(block, false);
            if (!text) continue;
            firstBlock = block;
            firstText = text;
            break;
        }
        let lastBlock: Element | null = null;
        let lastText: Node | null = null;
        for (let i = blocks.length - 1; i >= 0; i--) {
            const text = visibleTextIn(blocks[i], true);
            if (!text) continue;
            lastBlock = blocks[i];
            lastText = text;
            break;
        }
        // No visible text anywhere (empty document, blank lines only):
        // no leaf endpoints exist, hand back the outermost blocks so the
        // caller can fall back to block boundaries.
        if (!firstBlock) firstBlock = blocks[0] ?? null;
        if (!lastBlock) lastBlock = blocks[blocks.length - 1] ?? null;
        return { firstBlock, lastBlock, firstText, lastText };
    }

    private selectAllDom_() {
        setTimeout(() => this.applySelectAllDom_(), 0);
    }

    private applySelectAllDom_() {
        // The deferral window is one task; if the terminal state was already
        // cancelled in between (a click landed an ordinary cursor), applying
        // the select-all projection now would stomp on the user's action.
        if (!this._editorStore_.cursorInfo_.all_) return;
        const selection = document.getSelection();
        if (!selection) return;
        const rootEl = this._textAreaDom_;
        const { firstBlock, lastBlock, firstText, lastText } =
            this.selectAllDomEndpoints_();
        const range = document.createRange();
        if (firstText && lastText) {
            range.setStart(firstText, 0);
            range.setEnd(lastText, lastText.textContent?.length ?? 0);
        } else if (firstBlock && lastBlock) {
            // Only blocks without text leaves (<p><br></p>) — fall back to
            // block boundaries; there is nothing to paint anyway.
            range.setStartBefore(firstBlock);
            range.setEndAfter(lastBlock);
        } else {
            range.selectNodeContents(rootEl);
        }
        selection.removeAllRanges();
        selection.addRange(range);
    }

    /**
     * Reads the cursor position; skipped after a composition input.
     * * */
    private handleKeyDown_ = async (e: KeyboardEvent) => {
        const keysThatMoveCursor = [
            "ArrowLeft",
            "ArrowUp",
            "ArrowRight",
            "ArrowDown",
            "Home",
            "End",
            "PageUp",
            "PageDown",
        ];

        // Named command shortcuts (insert table / code block, heading toggles and
        // so on) do not belong to the kernel — the kernel only owns the keys that
        // must stay in lockstep with the model machinery (undo/redo, select-all,
        // Enter, Tab, IME). Command-level shortcuts are registered on window keydown
        // by the commands layer or by the host application.

        // Select-all (⌘A on macOS, Ctrl+A elsewhere) — enter the select-all
        // terminal state (cursorInfo_.all_).
        // The modifier check is platform-exact. On macOS, Ctrl+A is the
        // system's "move to beginning of paragraph" text binding; the old
        // (metaKey || ctrlKey) form hijacked it into the terminal state, and
        // the replayed whole-document range then polluted the selection the
        // native caret motion acted on — teleporting the caret to the start
        // of the document (issue #27, first report). Shift/Alt variants
        // (⌘⇧A …) have no select-all semantics anywhere and must not raise
        // the flag either: the browser performs no native select-all for
        // them, so the echo handshake would dangle on a non-selected
        // document. The letter matches by key cap (matchesLetterKey), not by
        // position, so the binding survives non-QWERTY layouts.
        // We preventDefault and build the whole-document selection ourselves
        // (selectAllDom_). The engine's own SelectAll used to be trusted here,
        // but it is not trustworthy: WebKit's native SelectAll command
        // collapses the selection to the document tail whenever the editable
        // root's first child is a non-editable overlay — exactly what hosts
        // mount (custom caret, remote-cursor layers) — which the user sees as
        // "Cmd+A flashes, then the selection vanishes" on the desktop
        // WKWebView (issue #27, second report; feature-isolated in a minimal
        // contenteditable: plain/hidden-syntax DOMs select fine, adding a
        // contenteditable=false absolute first child alone breaks it; Blink
        // is unaffected). preventDefault also stops the key equivalent from
        // reaching the desktop menu's native selectAll: — the same broken
        // engine command via another door.
        // The store side flags the terminal state: subsequent editing
        // operations (delete / typing / paste / cut / Enter / IME) go through
        // the whole-document primitive replaceAllContent_ and do not depend
        // on DOM coordinates — DOM coordinates cannot address the leading /
        // trailing serialization scaffolding (deleting through them leaves
        // stubs behind), and during a chunked load they do not cover the
        // unparsed part at all.
        // getCursorInfo() cannot be reused here: on select-all the start
        // container lands on the root node, so the marker cannot be inserted
        // into the first block (see the handleCopy / handleCut comments).
        // setSelectAll_ reads straight from renderData instead — start = the
        // first render block at offset 0, end = the full length of the last
        // render leaf.
        // Known gap: the mobile long-press menu's "Select All" does not go
        // through keydown, so it does not enter the terminal state yet (left
        // as is until we can observe the real path and settle on an
        // inference rule); a desktop menu-item "Select All" click does not
        // either — hosts should route their menu item through the store
        // (the DOMD desktop Edit menu does exactly that).
        // Deliberately ABOVE the read-only wall: select-all is a selection
        // gesture, and with the always-on copy handler it completes the
        // read-only surface (Cmd+A → Cmd+C yields the exact markdown). The
        // WebKit native-select-all bug bites read-only viewers with overlay
        // layers (remote cursors) just the same, so the takeover matters
        // there too; every editing consumer of the terminal state sits
        // below the wall.
        if (
            commandKey(e) &&
            !foreignCommandKey(e) &&
            !e.shiftKey &&
            !e.altKey &&
            matchesLetterKey(e, "a")
        ) {
            // During IME composition the DOM belongs to compositionSnapshot_ —
            // hands off entirely, matching the previous behaviour (the store
            // setters below are composition-guarded no-ops anyway).
            if (this._editorStore_.duringComposition) return;
            e.preventDefault();
            this._editorStore_.applyPendingText_();
            this._editorStore_.setSelectAll_();
            this.selectAllDom_();
            return;
        }

        // System text-navigation chords (NSStandardKeyBindingResponding:
        // Ctrl+A/E = paragraph start/end, Ctrl+N/P = next/previous line,
        // Ctrl+F/B = forward/backward), implemented natively by WebKit and
        // partially by Blink on macOS. They move the caret exactly like the
        // bare keys in keysThatMoveCursor but arrive as Ctrl+letter chords,
        // so they need the same speculative-input flush — without it the
        // armed pending timer wakes up after the caret has left and writes
        // the stale snapshot's cursor back (issue #27: "Ctrl+N/P land
        // unreliably and interfere with ↑/↓"). Editing-type bindings
        // (Ctrl+K/D/H/T/O/Y) mutate the DOM and travel through the
        // beforeinput machinery instead; they are deliberately not listed.
        // No platform gate: where a chord has no system binding the flush is
        // a no-op (applyPendingText_ short-circuits on empty pending; Ctrl+A
        // on Windows never reaches this point — the select-all branch above
        // flushes and returns).
        const isSystemNavigationChord =
            e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !e.shiftKey &&
            ["a", "e", "n", "p", "f", "b"].includes(e.key);

        // Check whether this is one of the cursor-moving keys
        if (keysThatMoveCursor.includes(e.key) || isSystemNavigationChord) {
            this._editorStore_.applyPendingText_();
        }

        // —— The read-only wall ——
        // Everything ABOVE is a selection gesture (select-all, the
        // speculative flush for caret motion — applyPendingText_ self-guards
        // and pending input cannot exist while read-only anyway) and serves
        // read-only surfaces too. Everything BELOW mutates the model
        // (undo/redo, Enter, Backspace, Tab). Returning here — before any
        // preventDefault — hands the keys straight back to the browser and
        // the host page while the document is read-only.
        if (!this._editorStore_.isEditable) return;

        // undo/redo — the platform's primary command modifier only. The old
        // (metaKey || ctrlKey) form swallowed macOS's Ctrl+letter system
        // bindings and Windows's Win+letter chords alike; shiftKey stays free
        // (Cmd/Ctrl+Shift+Z = redo), every other extra modifier opts out.
        // The letter matches by key cap (matchesLetterKey), not by position,
        // so the binding survives non-QWERTY layouts.
        if (
            commandKey(e) &&
            !foreignCommandKey(e) &&
            !e.altKey &&
            matchesLetterKey(e, "z")
        ) {
            e.preventDefault();
            if (this._editorStore_.duringComposition) {
                return;
            }
            if (e.shiftKey) {
                this._editorStore_.redo();
            } else {
                this._editorStore_.undo();
            }
            return;
        }

        switch (e.key) {
            case "Enter": {
                const newlineKey = this._editorStore_.newlineKey_;

                // Embed mode: Enter yields to the host and the newline is rebound
                // to newlineKey
                if (newlineKey) {
                    // During composition (the Enter that commits an IME
                    // candidate): neither break the line nor submit, leave it
                    // to the IME
                    if (
                        this._editorStore_.duringComposition ||
                        e.isComposing
                    ) {
                        return;
                    }
                    // Must be swallowed: do-md is controlled / speculative and
                    // data-driven, so letting it through would have the native
                    // contenteditable insert a line break and pollute the data layer
                    e.preventDefault();
                    if (matchesNewlineKey(e, newlineKey)) {
                        // The configured key = a literal newline (without the
                        // commandKey "escape the code block" semantics)
                        this.handleEnterInCursor_(false);
                    } else {
                        // A bare Enter and any other Enter combination are the
                        // submit kind: hand the store and the original event back
                        // to the host and let it decide
                        this._editorStore_.onEnter_?.(this._editorStore_, e);
                    }
                    break;
                }

                // Default full-featured editor: Enter splits the block / breaks
                // the line
                if (e.altKey) return;
                if (!this._editorStore_.duringComposition) {
                    e.preventDefault();
                    // Shift+Enter: soft break — whatever the context, it only
                    // inserts a literal "\n" and leaves the semantics to the reparse
                    // (inside a P = a soft break in the same paragraph; at the end
                    // of an li = the next li item; heading / blockquote = split at
                    // the \n).
                    if (e.shiftKey && !e.metaKey && !e.ctrlKey) {
                        this.handleSoftBreakInCursor_();
                    } else {
                        this.handleEnterInCursor_(commandKey(e));
                    }
                }
                break;
            }
            case "Backspace": {
                if (this._editorStore_.activeAtomicUUID_) {
                    this._editorStore_.chainProduceParsedData_((chain) => {
                        chain.moveCursorToSibling_(
                            this._editorStore_.activeAtomicUUID_!,
                        );
                        chain.removeFromParent_(
                            this._editorStore_.activeAtomicUUID_!,
                        );
                    });
                    this._editorStore_.setActiveAtomicUUID_(null);
                    break;
                }
                // Modifier variants (word / line deletes) need the
                // engine-computed getTargetRanges() and stay on the
                // beforeinput range mechanism (deleteRangeInCursor_).
                if (e.altKey || e.metaKey || e.ctrlKey) break;
                // During IME composition backspace belongs to the IME.
                if (this._editorStore_.duringComposition || e.isComposing) {
                    break;
                }
                // Take plain Backspace over at keydown — the primary desktop
                // path (same policy as ProseMirror's keymap and Lexical's
                // KEY_BACKSPACE_COMMAND). WebKit dispatches beforeinput from
                // inside the editing command, so whenever it deems
                // DeleteBackward a no-op (empty document; caret at the first
                // visible position while the syntax ahead is hidden) Safari /
                // WKWebView fire no beforeinput at all — yet the model-level
                // backspace still has semantics there (dissolve a construct /
                // outdent / merge). Chrome fires beforeinput unconditionally,
                // which masked the gap. The deleteContentBackward branch in
                // handleBeforeInput_ stays as the fallback for inputs that
                // never produce a trustworthy Backspace keydown (soft
                // keyboards' 229 sentinel, Ctrl+H-style bindings).
                e.preventDefault();
                // Mirror of handleBeforeInput_'s root-caret guard: repair a
                // caret parked on the root node and swallow the delete.
                if (this.normalizeRootCaret_()) break;
                this.deleteInCursor_();
                break;
            }
            case "Tab": {
                e.preventDefault();
                this.handleTabInCursor_();
                break;
            }
            case "ArrowDown":
            case "ArrowUp":
            case "ArrowLeft":
            case "ArrowRight": {
            }
        }
    };

    /**
     * TODO(mobile-autocomplete): `selectionchange` — off by default, kept as a
     * signpost
     * -------------------------------------------------------------------
     * Conclusion (assessed 2026-06): **we do not need this event right now, so no
     * listener is registered.**
     *
     * Why: every controlled operation that mutates data **reads the live DOM
     * selection on the spot** and never relies on the store's cache:
     *   getCursorInfo() (common/text) re-reads document.getSelection() every time;
     *   deleteInCursor_ / replaceSelect_ / handleEnterInCursor_ / cut / copy /
     *   paste / beforeinput all read live.
     * So no matter how the caret moves (long-pressing space on iOS to use the
     * keyboard as a trackpad, autocorrect / candidate-tap repositioning, dragging
     * the magnifier…), one live read at actual edit time yields the correct
     * position — **the edit point corrects itself, it does not depend on the stored
     * cursorInfo_.** This also matches "dragging the caret on iOS tests correct".
     *
     * The only price of not wiring it up: the store's cached cursorInfo_ goes
     * temporarily stale after "a caret move that fires neither click nor keydown";
     * the next edit overwrites it from a live DOM read, so it is harmless.
     *
     * ⚠️ When it would actually need enabling: as soon as a consumer appears that
     * **reads cursorInfo_ on its own, detached from an input action** — for example
     * a floating toolbar reading the stored selection to decide "is this bold?"
     * (its active state would not refresh after the selection moves), or a custom
     * caret rendered from the stored cursor. At that point, register the listener
     * and implement the following:
     * - It is on document, does not bubble and fires extremely often → it must be
     *   throttled (rAF / microtask debounce).
     * - Sync only while the selection is inside textAreaDom and we are not composing.
     * - Read the 1 or 2 endpoints with getCursorInfo() and write them back through
     *   setCursorInfo_, idempotently, to avoid a feedback loop with programmatic
     *   selection changes.
     */
    private handleSelectionChange_ = debounceWithRAF(async () => {
        if (this._editorStore_.duringComposition) return;
        const selection = document.getSelection();
        if (!selection) return;
        if (!this._textAreaDom_.contains(selection?.anchorNode)) return;
        const info = getCursorInfo();
        // —— Select-all terminal-state echo guard (a one-shot handshake) ——
        // Cmd+A sets all_ + selectAllEchoPending_ already at keydown; the browser's
        // default action applies the native select-all and fires selectionchange
        // only afterwards — so the first reading to arrive after the flag is set is
        // the terminal state's own echo. Consume the handshake bit, return right
        // away, and the terminal state survives.
        // Why not decide geometrically: Chrome snaps the select-all endpoints to the
        // first / last "visible" caret positions (measured: anchor = (first text, 0),
        // focus = (trailing EmptyP, 0), i.e. endpoints inside the elements), so
        // containsNode with full containment is necessarily false for the first and
        // last elements; and hidden syntax drifts the model offsets away from the
        // coordinates setSelectAll_ stored, so comparing for equality is just as
        // certain to fail.
        // The loose geometric check (the selection still touches both ends, partial
        // containment is enough) exists only to catch a stale flag — e.g. pressing
        // Cmd+A again while everything is already selected changes nothing and fires
        // no event, so the handshake bit would dangle until the next real reading.
        // This must sit before the root-container normalization guard: if an echo
        // endpoint lands on the root container, consume the handshake bit first and
        // let the root guard discard the reading afterwards, otherwise the handshake
        // bit is left dangling.
        // Once it has been consumed, later range / collapse writes land as usual, and
        // all_ clears itself when the object is replaced wholesale (so shift+click
        // and shift+arrow shrinking the selection exit the terminal state
        // correctly).
        if (this._editorStore_.selectAllEchoPending_) {
            this._editorStore_.selectAllEchoPending_ = false;
            if (this._editorStore_.cursorInfo_.all_ && info.length === 2) {
                // Probe the endpoint-hosting blocks, not
                // first/lastElementChild: the selection being echoed is the
                // one selectAllDom_ builds from visible text leaves, which
                // legitimately excludes the root's non-content scaffolding
                // (overlay divs) and text-less terminal blocks — probing
                // anything else would fail against our own selection and let
                // this very reading demote the terminal state to a plain
                // range.
                const { firstBlock, lastBlock } =
                    this.selectAllDomEndpoints_();
                if (
                    firstBlock &&
                    lastBlock &&
                    selection.containsNode(firstBlock, true) &&
                    selection.containsNode(lastBlock, true)
                ) {
                    return;
                }
            }
        }
        // —— Root-container normalization guard (selection-sync-design §2,
        // previously unimplemented) ——
        // On a backwards drag-selection, or when swiping up past the start of a
        // block, Chrome often reports the selection boundary on the container
        // element (the root div itself), and getClosestRenderDom then returns the
        // root's own data-render-id as renderUUID → the store is written the
        // pathological "uuid = root" coordinate: root is not a text block, so the
        // offset silently becomes a whole-document offset and every downstream
        // consumer of block-level coordinates (getNodeInfo with padding expanded,
        // collaborative cursor snapshots, model replay) ends up misaligned.
        // The rule: either endpoint of a range on root → discard the whole reading
        // (keep the last valid snapshot; the next selectionchange will bring a
        // corrected one); a collapsed caret on root with offset == 0 (after Cmd+A
        // collapses, or a click on the blank area) → normalize to the first content
        // block; everything else bails.
        const rootUuid = this._editorStore_.renderData_.uuid_;
        if (
            info.length === 2 &&
            (info[0].renderUUID === rootUuid ||
                info[1].renderUUID === rootUuid)
        ) {
            return;
        }
        if (info.length === 1 && info[0].renderUUID === rootUuid) {
            if (info[0].offset === 0) {
                const firstBlock =
                    this._editorStore_.renderData_.children_.find(
                        (c) => c.htmlProps_?.["data-render-id"],
                    );
                if (firstBlock) {
                    this._editorStore_.setCursorInfo_(
                        { uuid: firstBlock.uuid_, offset: 0 },
                        null,
                        CursorSource.Dom,
                    );
                }
            }
            return;
        }
        if (info.length === 1) {
            this._editorStore_.setCursorInfo_({
                uuid: info[0].renderUUID,
                offset: info[0].offset,
            }, null, CursorSource.Dom);
        } else if (info.length === 2) {
            this._editorStore_.setCursorInfo_(
                {
                    uuid: info[0].renderUUID,
                    offset: info[0].offset,
                },
                {
                    uuid: info[1].renderUUID,
                    offset: info[1].offset,
                }, CursorSource.Dom
            );
        }
    }, 100);

    /**
     * `blur` — commit the uncommitted speculative text into the data layer and put
     * out our caret on remote peers.
     * -------------------------------------------------------------------
     * A soft keyboard commits any unconfirmed candidate / composition at the instant
     * focus is lost, and on desktop a click that moves focus away can also leave an
     * uncommitted snapshot behind (the speculative render has not been merged back
     * into the model yet). We reuse applyPendingText_() here to consume the
     * pendingInput_ snapshot and commit it, so the last stretch of input is not lost.
     * applyPendingText_ already short-circuits on "no pendingInput_ / not editable",
     * so this is safe.
     *
     * Then setCursorFocused_(false): the outbound awareness direction reports "no
     * cursor" so collaborating peers hide our caret — otherwise, once we blur, peers
     * would keep painting a ghost caret at our last position. The internal
     * cursorInfo_ is not cleared (aiInsertInCursor and focus restoration still need
     * it).
     * Commit first, lights out second: this guarantees the final snapshot peers
     * receive is null (the text arrives first, the caret goes dark after).
     */
    private handleBlur_ = async () => {
        this._editorStore_.applyPendingText_();
        this._editorStore_.setCursorFocused_(false);
    };

    /**
     * `focus` — when focus returns to the editor, re-emit the real cursor snapshot so
     * remote peers light our caret back up.
     * Symmetric with handleBlur; the internal cursorInfo_ was kept all along, so all
     * this does is release awareness's blur gate.
     */
    private handleFocus_ = async () => {
        this._editorStore_.setCursorFocused_(true);
    };

    /**
     * `drop` — route dropped text through the controlled insertText and forbid the
     * browser's native insertion.
     * -------------------------------------------------------------------
     * A native drop rewrites the DOM directly (dragging in from outside = an insert;
     * dragging within the editor = an insert plus a delete at the source), bypassing
     * the data layer. So we always preventDefault, then:
     * 1. Use caretRangeFromPoint(drop point) to move the DOM selection to the drop
     *    position — otherwise insertText would land in the stale pre-drag selection.
     *    Firefox falls back to caretPositionFromPoint.
     * 2. Reuse editorStore.insertText() for a controlled plain-text insert (the same
     *    path handlePaste takes).
     *
     * Only plain text (text/plain) is handled. Dropped files / images
     * (dataTransfer.files, text/uri-list) are not supported yet; when they are, add
     * a separate branch that reads files and goes through the image-insert logic.
     */
    private handleDrop_ = async (e: DragEvent) => {
        e.preventDefault();
        const text = e.dataTransfer?.getData("text") || "";
        if (!text) return;

        // Position the caret at the drop point, then let insertText read that
        // selection live
        const doc = document as Document & {
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
            caretPositionFromPoint?: (
                x: number,
                y: number,
            ) => { offsetNode: Node; offset: number } | null;
        };
        const selection = document.getSelection();
        if (selection) {
            let range: Range | null = null;
            if (doc.caretRangeFromPoint) {
                range = doc.caretRangeFromPoint(e.clientX, e.clientY);
            } else if (doc.caretPositionFromPoint) {
                const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
                if (pos) {
                    range = document.createRange();
                    range.setStart(pos.offsetNode, pos.offset);
                    range.collapse(true);
                }
            }
            if (range) {
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }

        const dropInfo = getCursorInfo();
        if (!dropInfo.length) return;
        // The drop has already moved the caret to the landing point, which is
        // "move the cursor" semantics. If the select-all terminal state is still set
        // (selectionchange clears it on a 100ms trailing debounce, which may not have
        // run yet), write the landing point first to clear the terminal state, so
        // insertText does not wrongly take the whole-document replace path.
        if (this._editorStore_.cursorInfo_.all_ && dropInfo.length === 1) {
            this._editorStore_.setCursorInfo_(
                {
                    uuid: dropInfo[0].renderUUID,
                    offset: dropInfo[0].offset,
                },
                null,
                CursorSource.Dom,
            );
        }
        this._editorStore_.insertText(text);
    };

    /**
     * `dragstart` — disable dragging from inside the editor.
     * -------------------------------------------------------------------
     * When text selected inside the editor is dragged out or around, the native drop
     * also performs a "delete at the source" — a DOM mutation that bypasses the data
     * layer. We simply preventDefault to switch internal dragging off and let users
     * copy and paste instead (which is how mobile works anyway). Text dragged in from
     * outside is still handled, under control, by handleDrop and is unaffected.
     */
    private handleDragStart_ = async (e: DragEvent) => {
        e.preventDefault();
    };

    private handleKeyPress_ = async () => {

    };

    private handleKeyUp_ = async () => { };

    /**
     * `mousedown` with detail >= 3 — take over paragraph-granularity
     * multi-click selection (triple-click and beyond).
     * -------------------------------------------------------------------
     * The native triple-click selects "the paragraph", and the engines
     * anchor the selection END at offset 0 of the FOLLOWING block — the
     * selected string carries a trailing "\n" and the end endpoint lives
     * outside the clicked block. Every consumer downstream then sees a
     * range crossing a structural wall the user never selected across, and
     * replacing the selection eats the wall itself: in a table cell the
     * cell boundary is destroyed and the row is left malformed (issue
     * #42); on the last code line the closing fence would be swallowed the
     * same way. Patching each edit path against the spilled endpoint is
     * hopeless — a hand-dragged selection ending at a block start is
     * legitimate (deleting it SHOULD merge the boundary), so the spilled
     * state cannot be told apart from real intent after the fact. Instead,
     * own the gesture (the ProseMirror approach): compute the extent
     * ourselves and never let a multi-click selection leave the clicked
     * render block.
     *
     * Extent = the LINE around the click point inside the closest render
     * block (getLineExtent): from the previous "\n" to the next "\n" of
     * the block's visible text. This reproduces native granularity
     * everywhere — a paragraph or a table cell has no inner "\n" so the
     * whole block content is selected; a multi-line code area yields the
     * clicked code line, matching how browsers treat preserved newlines
     * as paragraph boundaries.
     *
     * Both extent offsets go through getDomByCursor, whose hidden-symbol
     * snapping moves an endpoint out of concealed syntax runs (a leading
     * "# ", a trailing "**") — so the selection is byte-identical to what
     * a manual drag over the visible text would produce, and every edit
     * over it flows through the same downstream semantics as a
     * hand-dragged selection (adjustCursor_'s symbol-edge affinity
     * included).
     *
     * preventDefault() suppresses the native selection and the DOM
     * selection is written synchronously, so every live reader
     * (beforeinput replace, copy, the debounced selectionchange sync) sees
     * the normalized range; the store is fed through the ordinary
     * selectionchange path, not written here. Non-primary buttons,
     * shift-extended clicks, read-only mode and clicks that resolve to no
     * render block (root scaffolding) are left native (read-only through
     * the registry's mutation-gesture policy, not an inline check) —
     * nothing can edit across the spill in read-only mode, and the
     * root-caret repair owns the scaffolding case.
     */
    private handleMouseDown_ = (e: MouseEvent) => {
        if (e.detail < 3 || e.button !== 0 || e.shiftKey) return;

        // Click point → DOM position (Blink/WebKit caretRangeFromPoint,
        // Firefox caretPositionFromPoint — same fallback as handleDrop_).
        const doc = document as Document & {
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
            caretPositionFromPoint?: (
                x: number,
                y: number,
            ) => { offsetNode: Node; offset: number } | null;
        };
        let node: Node | null = null;
        let nodeOffset = 0;
        if (doc.caretRangeFromPoint) {
            const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
            if (r) {
                node = r.startContainer;
                nodeOffset = r.startOffset;
            }
        } else if (doc.caretPositionFromPoint) {
            const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) {
                node = pos.offsetNode;
                nodeOffset = pos.offset;
            }
        }
        if (!node || !this._textAreaDom_.contains(node)) return;
        const host = node instanceof HTMLElement ? node : node.parentElement;
        if (!host) return;
        const blockEl = getClosestRenderDom(host);
        if (!blockEl) return;
        const uuid = getIdByRenderDom(blockEl);
        // The root container is not a text block — keep native behavior
        // there (the selectionchange root guard discards such readings).
        if (!uuid || uuid === this._editorStore_.renderData_.uuid_) return;

        // Visible offset of the click inside the block, then the line
        // extent around it in the block's visible text.
        const preRange = document.createRange();
        preRange.selectNodeContents(blockEl);
        try {
            preRange.setEnd(node, nodeOffset);
        } catch {
            return;
        }
        const text = getVisibleDomText(blockEl);
        const extent = getLineExtent(text, getVisibleRangeLength(preRange));

        const start = getDomByCursor(blockEl, extent.start);
        const end = getDomByCursor(blockEl, extent.end);
        if (!start.node || !end.node) return;

        e.preventDefault();
        const selection = document.getSelection();
        if (!selection) return;
        selection.setBaseAndExtent(
            start.node,
            start.offset,
            end.node,
            end.offset,
        );
    };

    /**
     * Clicks are where root-level carets are born: a click on the root
     * contenteditable's own padding, or on the margin gap between blocks
     * (below the last block included), makes Chrome park the collapsed caret
     * on the root node itself. Repair it at mouseup time, before any typing
     * can happen. Range selections are untouched — the guard inside
     * normalizeRootCaret_ only acts on a collapsed caret anchored on root.
     */
    private handleClick_ = async () => {
        this.normalizeRootCaret_();
    };

    /**
     * Repair a collapsed caret the browser parked on the ROOT contenteditable
     * node itself. Such a caret belongs to no block, so the model cannot
     * address it — getSelectionOffsets() reports null and every
     * offset-addressed command goes dead — and browser-default typing there
     * inserts a bare text node directly under the root that no model node
     * owns (the same "root ghost" family as the focus() ghost). The
     * selectionchange sync deliberately discards root readings, so without
     * this repair the store cursor stays stale indefinitely.
     *
     * The root child offset sits between root.childNodes[offset - 1] and
     * [offset]: normalize to the START of the first addressable block at or
     * after it, else to the END of the last addressable block before it.
     * Line-break scaffolding (LineBr / LineBrBr) is not addressable.
     *
     * The store is written first, then the DOM selection is placed
     * synchronously — closing the window between the click and the first
     * keystroke during which typing would still hit the root layer. The
     * render layer's replayCursor_ pass afterwards is idempotent ("do not
     * replay if the DOM is already in place"), so the double write is safe.
     */
    private normalizeRootCaret_(): boolean {
        const selection = document.getSelection();
        if (
            !selection ||
            !selection.isCollapsed ||
            selection.anchorNode !== this._textAreaDom_
        ) {
            return false;
        }
        const root = this._textAreaDom_;
        const nodes = root.childNodes;
        const at = Math.min(selection.anchorOffset, nodes.length);

        const addressableUuid = (node: Node): string | null => {
            if (!(node instanceof HTMLElement)) return null;
            const uuid = node.getAttribute("data-render-id");
            if (!uuid) return null;
            const data = getRenderDataById(
                uuid,
                this._editorStore_.renderData_,
            );
            if (
                !data ||
                data.htmlType_ === MarkdownType.LineBr ||
                data.htmlType_ === MarkdownType.LineBrBr
            ) {
                return null;
            }
            return uuid;
        };

        let uuid: string | null = null;
        let placeAtStart = true;
        for (let i = at; i < nodes.length && !uuid; i++) {
            uuid = addressableUuid(nodes[i]);
        }
        if (!uuid) {
            placeAtStart = false;
            for (let i = at - 1; i >= 0 && !uuid; i--) {
                uuid = addressableUuid(nodes[i]);
            }
        }
        if (!uuid) return false;

        // Clicking BELOW a document whose last block is structural or atomic
        // (a code fence, a table, a rule, an image) must NOT park the caret
        // inside that block — the caret would live in code/table space, every
        // offset-addressed command would see a guarded line, and typing would
        // write INTO the block. What the user clicked toward is a fresh line
        // below it: create the empty paragraph through the kernel's own
        // primitive (blank-line separator included, cursor set via marker),
        // and let the render pass place the DOM caret. An existing empty
        // paragraph is entered instead (its visible text is empty, so the
        // generic placement below lands at offset 0), so repeated clicks do
        // not pile up empties.
        const data = getRenderDataById(uuid, this._editorStore_.renderData_);
        if (!data) return false;
        if (
            !placeAtStart &&
            (data.htmlType_ === MarkdownType.Pre ||
                data.htmlType_ === MarkdownType.PreEmpty ||
                data.htmlType_ === MarkdownType.Table ||
                data.htmlType_ === MarkdownType.Hr ||
                data.htmlType_ === MarkdownType.Img)
        ) {
            const structuralUuid = uuid;
            this._editorStore_.chainProduceParsedData_((chain) => {
                chain.addEmptyPToNext_(structuralUuid, true);
            });
            return true;
        }

        const blockDom = getRenderDomByID(uuid, root);
        if (!blockDom) return false;
        const offset = placeAtStart
            ? 0
            : (getVisibleDomText(blockDom) || "").length;

        // A pure caret placement, not the tail of an edit → disableRecord,
        // the same opt-out setSelection takes (no pure-cursor undo entries).
        this._editorStore_.setCursorInfo_(
            { uuid, offset },
            null,
            CursorSource.Model,
            true,
        );
        const { node, offset: domOffset } = getDomByCursor(blockDom, offset);
        const range = document.createRange();
        range.setStart(node ?? blockDom, node ? domOffset : 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    private handleCompositionStart_ = () => {
        // Pending format marks are deliberately not cleared here: during
        // composition selectionchange short-circuits and the model caret does not
        // move, so the anchor stays valid; compositionend's snapshot path consumes
        // them by anchor match (a Chinese user turns on a format from the toolbar →
        // types pinyin → the committed characters come out wrapped). The no-snapshot
        // fallback path clears them inside compositionend.
        this._editorStore_.setDuringComposition_(true);

        const cursorInfo = getCursorInfo();
        if (cursorInfo.length !== 1) {
            // Composition over a selection, or across nodes, is not handled
            // precisely yet: take the fallback path
            this._editorStore_.setCompositionSnapshot_(null);
            return;
        }

        const { renderElement, renderUUID, offset } = cursorInfo[0];
        const renderData = getRenderDataById(
            renderUUID,
            this._editorStore_.renderData_,
        ) as ParentRenderData | undefined;
        const isPreCode = renderData?.htmlType_ === MarkdownType.PreCode;
        const preCodeUuid = isPreCode
            ? this.getParent_(renderData!, 1)?.uuid_
            : undefined;

        this._editorStore_.setCompositionSnapshot_({
            uuid_: renderUUID,
            text_: getVisibleDomText(renderElement),
            offset_: offset,
            isPreCode_: isPreCode,
            preCodeUuid_: preCodeUuid,
        });
    };

    private handleCompositionUpdate_ = async () => { };

    private handleCompositionEnd_ = async (e: CompositionEvent) => {
        // Registered "always": compositionend is the composition state
        // machine's CLOSER, and the closer must run even if the document
        // went read-only mid-composition (a collab role change, a host
        // flipping setEditable under a live IME) — gating it away would
        // strand duringComposition_ = true forever, blocking every future
        // flush and the whole selectionchange sync. Read-only closes the
        // machine but commits nothing; no preventDefault either — the DOM
        // was never ours to own in that state.
        if (!this._editorStore_.isEditable) {
            this._editorStore_.setCompositionSnapshot_(null);
            this._editorStore_.clearPendingFormatMarks_();
            this._editorStore_.setDuringComposition_(false);
            return;
        }
        e.preventDefault();
        const snapshot = this._editorStore_.compositionSnapshot_;
        this._editorStore_.setCompositionSnapshot_(null);

        // No snapshot (composition over a selection / across nodes): take the old
        // fallback path. Pending format marks cannot be wrapped safely on this path
        // → clear them.
        if (!snapshot) {
            try {
                // Select-all terminal state + IME (select everything, then start
                // typing pinyin — a very frequent move for Chinese users): during
                // composition the IME has already natively removed the selected DOM,
                // and parseInCursor_ only reparses the caret's block, which would
                // resurrect the other blocks from the model. Replace the whole
                // document with e.data instead (what the IME actually committed;
                // empty when cancelled with ESC = clear everything, matching
                // native).
                if (this._editorStore_.cursorInfo_.all_) {
                    this._editorStore_.replaceAllContent_(e.data || "");
                    return;
                }
                this._editorStore_.clearPendingFormatMarks_();
                this.parseInCursor_();
            } finally {
                this._editorStore_.setDuringComposition_(false);
            }
            return;
        }

        try {
            // e.data is what the IME actually committed: on a normal end it is the
            // chosen characters, while switching input methods or pressing ESC can
            // leave an empty string or already-sanitized pinyin.
            // The key rule: trust e.data only, never the DOM's textContent (the IME
            // polluted it during composition).
            let committed = e.data || "";
            let caretShift = 0;
            // The IME path for pending format marks: the snapshot (text, offset)
            // plus e.data is exactly what insertText is in the composition world —
            // the very same consumer implementation wraps the committed text (a
            // Chinese user turns on a format from the toolbar → typing comes out
            // bold). If the anchor does not match, clear them (the caret has
            // drifted).
            const wrapped = snapshot.isPreCode_
                ? null
                : this._editorStore_.consumePendingFormatMarks_(committed, {
                    uuid: snapshot.uuid_,
                    offset: snapshot.offset_,
                });
            if (wrapped) {
                committed = wrapped.text_;
                caretShift = wrapped.caretShift_;
            } else {
                this._editorStore_.clearPendingFormatMarks_();
            }
            const newText =
                snapshot.text_.slice(0, snapshot.offset_) +
                committed +
                snapshot.text_.slice(snapshot.offset_);
            const newOffset =
                snapshot.offset_ + committed.length + caretShift;

            if (snapshot.isPreCode_ && snapshot.preCodeUuid_) {
                const preData = getRenderDataById(
                    snapshot.preCodeUuid_,
                    this._editorStore_.renderData_,
                ) as ParentRenderData | undefined;
                if (!preData) return;
                const fenceOpen =
                    (preData.children_[0] as RenderData).text_ || "";
                const fullText =
                    fenceOpen +
                    "\n" +
                    this._editorStore_.insertCursorMarker_(newText, newOffset) +
                    "\n```";
                this._editorStore_.chainProduceParsedData_((chain) => {
                    chain.resetTextByUUID_(snapshot.preCodeUuid_!, fullText);
                });
            } else {
                this._editorStore_.chainProduceParsedData_((chain) => {
                    chain.resetTextByUUID_(
                        snapshot.uuid_,
                        this._editorStore_.insertCursorMarker_(
                            newText,
                            newOffset,
                        ),
                    );
                });
            }
            this._editorStore_.setPendingInput_(null);
            this._editorStore_.updatePaddingMdSybolsAfterRender_();
        } finally {
            // Keep the DOM exclusively owned by the composition snapshot
            // until the committed text is in the model. Transitioning
            // earlier lets synchronous store subscribers flush the IME DOM.
            this._editorStore_.setDuringComposition_(false);
        }
    };

    private handleCut_ = async (e: ClipboardEvent) => {
        e.preventDefault();

        // Select-all terminal state: put the full serialization on the clipboard
        // and clear the whole document. The marker-injection path can only
        // approximate select-all (a root-container endpoint has nowhere to insert
        // the marker); this path is exact.
        if (this._editorStore_.cursorInfo_.all_) {
            copyTextToClipboard(toMarkdown(this._editorStore_.renderData_));
            this._editorStore_.replaceAllContent_("");
            return;
        }

        const cursorInfo = getCursorInfo().map(this.adjustCursor_);

        if (!cursorInfo.length) return;

        // @ts-ignore
        const text = toMarkdown(this._editorStore_.renderData_, cursorInfo);
        const first = text.indexOf(CursorMarker);
        const last = text.lastIndexOf(CursorMarker);
        // With a single marker (select-all, for instance) treat `before` as empty,
        // so the selection is not left behind in the document after the cut
        const before = first === last ? "" : text.slice(0, first);
        const selected =
            first === last
                ? text.slice(0, first)
                : text.slice(first + CursorMarker.length, last);
        const after = text.slice(last + CursorMarker.length);
        const newText = before + CursorMarker + after;
        let findCursorInfo: CursorInfo | null = null;
        const parseData = parseMarkdown(newText, {
            codeTokenizer_: this._editorStore_.codeTokenizer_,
            inlineRules_: this._editorStore_.inlineRules_,
            imgGroupSeparators_: this._editorStore_.imgGroupSeparators_,
            onCursorFound_: (cursorInfo: CursorInfo) => {
                findCursorInfo = cursorInfo;
            },
        });
        splitTextSpans(parseData);
        this._editorStore_.setParsedData_(parseData);
        if (findCursorInfo) {
            this._editorStore_.setCursorInfo_(findCursorInfo);
        }
        copyTextToClipboard(selected);
    };

    private handleCopy_ = async (e: ClipboardEvent) => {
        e.preventDefault();
        // Select-all terminal state: emit the full serialization directly (the old
        // single-marker fallback could only approximate the full text; it is kept
        // around to serve root-container selections that never entered the terminal
        // state, such as the mobile OS's own select-all).
        if (this._editorStore_.cursorInfo_.all_) {
            copyTextToClipboard(toMarkdown(this._editorStore_.renderData_));
            return;
        }
        const cursorInfo = getCursorInfo().map(this.adjustCursor_);
        if (!cursorInfo.length) return;

        // @ts-ignore
        const text = toMarkdown(this._editorStore_.renderData_, cursorInfo);
        const first = text.indexOf(CursorMarker);
        const last = text.lastIndexOf(CursorMarker);
        // Normal selection: two markers bracket the selection -> take what is
        // between them.
        // On select-all the start cursor may land on the root container so the start
        // marker never gets inserted, leaving only the trailing marker -> take
        // everything before it.
        const selected =
            first === last
                ? text.slice(0, first)
                : text.slice(first + CursorMarker.length, last);
        copyTextToClipboard(selected);
    };

    private handlePaste_ = async (e: ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData?.getData("text") || "";
        const cursorInfo = getCursorInfo();

        if (!cursorInfo.length) return;
        this._editorStore_.insertText(text);
    };

    // ======================================================================
    // Cursor replay, model → DOM (migrated from hooks/UseCursor)
    // The other half of the same selection-sync protocol as
    // handleSelectionChange_ (DOM → model).
    //
    // The trigger contract (the render layer's commit signal): the replay must land
    // "after the render layer has flushed the new renderData into the DOM, and
    // before the next paint". Only the render layer knows that instant — any timing
    // trick on the controller side is guessing at the commit, and it goes wrong in
    // both directions:
    //   · Triggering synchronously (during the addEffect notification = before the
    //     commit): blocks that undo remounts cannot be found and the new uuids from
    //     a reparse do not exist yet → the replay bails, or anchors into old nodes
    //     that are about to be unmounted;
    //   · Triggering on a delay (setTimeout / rAF): a race against the render
    //     layer's commit — guess too late and "new DOM + un-replayed old selection"
    //     gets painted for a frame first (caret ghosting, reproduced in testing);
    //     guess too early (an async commit at Default priority, such as
    //     aiInsertInCursor's streaming insert going through a Scheduler macrotask)
    //     and the replay reads the old DOM and is simply lost.
    // So the render layer owns the trigger: the binding layer calls replayCursor_()
    // after "the DOM commit caused by a cursorInfo_ change". All the replay logic
    // (the guard matrix, scrolling) lives in this class and each framework
    // contributes a single line of trigger — this is part of the render-layer
    // contract, not a dependency on a framework (ProseMirror is isomorphic here:
    // the view calls setSelection synchronously after the DOM update, since writing
    // the selection is simply the closing act of rendering).
    //
    // Reference React binding (replayCursor_ gates read-only internally, so
    // the binding itself needs no isEditable check):
    //   const cursorInfo = useEditorStore((s) => s.cursorInfo_);
    //   useEffect(() => { controller.replayCursor_(); }, [cursorInfo]);
    // Vue: watch(cursorInfo, () => nextTick(replay)); Svelte: $effect + tick().
    // The replay is idempotent ("do not replay if the DOM is already in place" plus
    // a live read of the store's latest cursorInfo_), so one extra call after the
    // commit has no side effects.
    // ======================================================================

    public replayCursor_() {
        // Read-only surfaces never express the model cursor in the DOM:
        // there is no kernel caret to keep honest, and rewriting the native
        // selection would fight the user's own read-and-select gestures.
        // The gate lives here so every framework binding inherits it — the
        // React binding's conditional <UseCursor/> mount is defense in
        // depth, not the contract.
        if (!this._editorStore_.isEditable) return;
        this._replaySelection_(true);
    }

    /**
     * The selection-replay body shared by the render-layer contract
     * (replayCursor_, scrollIntoView = true: after an edit/undo the caret must
     * be visible) and view-state restoration (restoreViewState_, scrollIntoView
     * = false: re-attaching a view restores the selection as a fact, while the
     * viewport is restored independently by the scroll anchor — a caret that
     * was off-screen at detach time stays off-screen).
     */
    private _replaySelection_(scrollIntoView: boolean) {
        // —— Focus guard (first rule of the replay matrix) ——
        // While the editor is blurred, cursorInfo_ is a RECORD, not something
        // the DOM should express: writing the native selection into an
        // unfocused contenteditable paints a gray inactive highlight out of
        // nowhere and steals whatever selection the user holds elsewhere on
        // the page. This mirrors the store's own blur semantics (awareness
        // reports null while cursorInfo_ is kept) — the DOM expression obeys
        // the same gate. Covers every blurred-state cursorInfo_ change:
        // collaborative re-anchoring, AI edits, undo through native menus,
        // and the view-attach replay of a store that was blurred at detach.
        // When focus returns, the focus gesture (controller.focus()) or the
        // attach protocol re-materializes the selection from the store.
        if (!this._editorStore_.focused_) return;
        // The replay criterion moved from a blanket "never replay when
        // source_ === Dom" to "do not replay if the DOM is already in place"
        // (idempotent): the former meant a Dom-sourced cursor restored by undo would
        // never be replayed → after the re-render the native selection loses its
        // anchor and collapses to the start of the paragraph; the latter naturally
        // skips live gestures (where the DOM is already at the target position) yet
        // still replays for undo (where the DOM has lost its anchor).
        const cursorInfo = this._editorStore_.cursorInfo_;
        const startCursorInfo = cursorInfo.start_;
        const endCursorInfo = cursorInfo.end_;
        if (!startCursorInfo) {
            // Deliberately cancelling the cursor: clear the browser's native
            // selection, otherwise the previous caret keeps being rendered
            const selection = document.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            return;
        }

        // —— Gesture-truth guard ——
        // A Dom-sourced cursorInfo is really "a lagging echo of the DOM selection":
        // the selectionchange sync is a 100ms trailing debounce, so while a drag
        // selection is in progress, or just after the button is released, the store
        // snapshot is necessarily behind the native selection. If a live,
        // non-collapsed selection exists in the editor at that moment, using the
        // lagging echo to collapse() / addRange() kills the user's gesture on the
        // spot — this is the root cause of "a backwards drag selection vanishes by
        // itself": a forward drag anchors at the doc-order start, whose failure path
        // is the safe bail on !startDom, whereas a backwards drag anchors at the
        // doc-order end, and a failed endDom lookup used to fall through to the
        // collapse() branch below. That is where the asymmetry between the two
        // directions came from (confirmed by a black-box call-stack experiment).
        // The rule (selection-sync-design §3, the replay matrix): Dom-sourced + a
        // live selection in the editor → zero DOM side effects (record only), and
        // let the next selectionchange bring the store into line; Model-sourced
        // (restoring the selection after an edit / undo / format) replays as usual.
        const liveSelection = document.getSelection();
        const liveRangeInEditor =
            !!liveSelection &&
            liveSelection.rangeCount > 0 &&
            !liveSelection.isCollapsed &&
            this._textAreaDom_.contains(liveSelection.anchorNode);
        if (cursorInfo.source_ === CursorSource.Dom && liveRangeInEditor) {
            return;
        }

        // —— Select-all terminal state: whole-container terms only ——
        // all_'s (uuid, offset) pair only approximates "the whole document",
        // so replaying it through the leaf-coordinate machinery below is
        // wrong twice over: the strict endpoint-equality check can never
        // confirm an existing whole-document selection (its endpoints snap
        // to visible positions, ours resolve into hidden syntax runs), and
        // the rebuilt range would then fight the selection built at keydown
        // — every replay pass rewriting the live selection is exactly the
        // flicker class issue #27 reported.
        // 1. Already in place — a live range touching both the first and the
        //    last render block (the same coverage geometry the
        //    selectionchange echo guard uses; the probe must skip the root's
        //    non-content scaffolding divs, which a rebuilt range
        //    legitimately excludes) → zero side effects.
        // 2. Otherwise (undo restored the terminal state, a re-render
        //    dropped the selection anchors) rebuild via selectAllDom_.
        // No scrolling either way: select-all must not move the viewport.
        if (cursorInfo.all_) {
            const { firstBlock, lastBlock } = this.selectAllDomEndpoints_();
            if (
                liveRangeInEditor &&
                liveSelection &&
                firstBlock &&
                lastBlock &&
                liveSelection.containsNode(firstBlock, true) &&
                liveSelection.containsNode(lastBlock, true)
            ) {
                return;
            }
            this.selectAllDom_();
            return;
        }

        // Scope uuid lookups to THIS editor's DOM: with multiple editors on
        // one page rendering clones of the same document (identical uuids —
        // e.g. the CRDT playground), a document-wide query would restore the
        // caret into the first editor in DOM order instead of this one.
        const scope = this._textAreaDom_;
        const startDom = getRenderDomByID(startCursorInfo.uuid, scope);
        if (!startDom) return;

        const { node: startNode, offset: startOffset } = getDomByCursor(
            startDom,
            startCursorInfo.offset,
        );

        if (endCursorInfo) {
            const endDom = getRenderDomByID(endCursorInfo.uuid, scope);
            // When the end's DOM cannot be found we must bail, symmetrically with
            // !startDom. There used to be no return here, so a range cursor would
            // fall through to the collapse() branch below — escalating "lookup
            // failed" into "destroy the selection", and only ever hitting backwards
            // selections (whose anchor happens to be the doc-order end). A
            // half-resolvable state must produce no DOM side effects at all.
            if (!endDom) return;

            const { node: endNode, offset: endOffset } = getDomByCursor(
                endDom,
                endCursorInfo.offset,
            );
            const selection = document.getSelection();
            if (selection) {
                // Do not replay when the DOM is already in place: Dom-sourced
                // selection coordinates were read out of the DOM to begin with, the
                // native selection is already there, and a programmatic addRange
                // would only interrupt a gesture in progress on mobile (the
                // magnifier, the selection handles). Both anchor/focus orientations
                // of a backwards drag selection are covered. When undo/redo restores
                // state the blocks are re-rendered and the native selection loses
                // its anchor → no match → replay.
                const already =
                    (selection.anchorNode === startNode &&
                        selection.anchorOffset === startOffset &&
                        selection.focusNode === endNode &&
                        selection.focusOffset === endOffset) ||
                    (selection.anchorNode === endNode &&
                        selection.anchorOffset === endOffset &&
                        selection.focusNode === startNode &&
                        selection.focusOffset === startOffset);
                if (!already) {
                    const range = document.createRange();
                    range.setStart(startNode as Node, startOffset);
                    range.setEnd(endNode as Node, endOffset);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    if (scrollIntoView) {
                        this.scrollToCursor_(endNode as HTMLElement);
                    }
                }
            }
            return;
        }

        const selection = document.getSelection();
        // Same for a collapsed cursor: if the DOM is already at the target
        // position, cut the replay short and preserve the native gesture; only
        // collapse when the anchor has been lost.
        if (
            selection?.isCollapsed &&
            selection.anchorNode === startNode &&
            selection.anchorOffset === startOffset
        ) {
            return;
        }
        selection?.collapse(startNode as Node, startOffset);
        if (scrollIntoView) {
            this.scrollToCursor_(startNode as HTMLElement);
        }
    }

    private scrollToCursor_(curNode: HTMLElement, PaddingBottom = 50) {
        try {
            if (!curNode?.parentNode) return;
            curNode = curNode?.parentNode as HTMLElement;
            while (window.getComputedStyle(curNode).display === "none") {
                curNode = curNode?.nextSibling as HTMLElement;
            }
            if (!curNode) return;
            const editorElement = this._textAreaDom_
                .parentNode as HTMLElement;
            const visibleRange: { top: number; bottom: number } = {
                top: editorElement?.scrollTop || 0,
                bottom:
                    editorElement?.scrollTop +
                    editorElement?.clientHeight || 0,
            };

            const cursorCoords = {
                top: getOffsetTop(curNode, editorElement),
                bottom:
                    getOffsetTop(curNode, editorElement) +
                    curNode.clientHeight,
            };

            if (cursorCoords.top < visibleRange.top) {
                editorElement.scrollTop = cursorCoords.top;
            } else if (cursorCoords.bottom > visibleRange.bottom) {
                editorElement.scrollTop =
                    cursorCoords.bottom - editorElement.clientHeight;
            }
        } catch { }
    }
}
