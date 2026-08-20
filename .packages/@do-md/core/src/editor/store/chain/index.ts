import {
    CursorInfo,
    CursorSource,
    InlineFormat,
    ParentRenderData,
    RenderData,
    RootRenderData,
    StoreState,
    Token,
} from "../../type";
import { getCursorInfoByParseData } from "../../model/cursor/getCursorInfoByParseData";
import { getLastRender } from "../../model/tree/getLastRender";
import { getNodeInfo } from "../../model/tree/getNodeInfo";
import { getParentAndIndex } from "../../model/tree/getParentAndIndex";
import { getRenderDataById } from "../../model/tree/getRenderDataById";
import { toMarkdown } from "../../model/serialize/toMarkdown";
import { createEmptyP } from "../../../data-parse/create-render-data/createEmptyP";
import { createEmptyUL } from "../../../data-parse/create-render-data/createEmptyUL";
import { createEmptyOl } from "../../../data-parse/create-render-data/createEmptyOl";
import { nanoid8 as uuid } from "@do-md/utils";
import { parseMarkdown } from "../../../data-parse/parseMarkdown";
import { CompiledInlineRules } from "../../../data-parse/inline-rules";
import { MarkdownType } from "../../type/enum";
import { CursorMarker, ZeroWidthSpace } from "../../constant";
import { mergeParsedBlock } from "../../model/merge/mergeStructural";
import { splitTextSpans } from "../../../data-parse/postprocess/splitTextSpans";
import { withSpanAnchor } from "../../model/cursor/withSpanAnchor";

// When a selection delete/replace empties a code block (the spliced result looks
// like "```lang\n" + CursorMarker + "\n```"), the empty code line cannot hold the
// block up and there is nowhere to put the caret to keep editing. We then do what
// creating a fresh code block does (see EditorController.ts, Enter after ```) and
// pad a ZeroWidthSpace in after the CursorMarker. `before` is the whole text ahead
// of the deletion point (inserted text included), `after` the whole text behind
// it.
const padIfEmptyCodeBlock = (before: string, after: string) =>
    /(^|\n)```[^\n]*\n$/.test(before) && after.startsWith("\n```")
        ? ZeroWidthSpace
        : "";

// Selection endpoint uuid → index of the top-level root child. An endpoint may sit
// deep inside a nested structure (a table cell / a code line / an li), so we search
// the subtree of every top-level child. Returns -1 when not found (the caller then
// falls back to a full reparse).
const topLevelIndexOf = (id: string, root: RootRenderData): number => {
    const children = root.children_ || [];
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (
            child.uuid_ === id ||
            getRenderDataById(id, child as ParentRenderData)
        ) {
            return i;
        }
    }
    return -1;
};

export const editorStateChainable = (
    draft: StoreState,
    codeTokenizer?: (code: string, lang?: string) => Token[],
    inlineRules?: CompiledInlineRules,
    imgGroupSeparators?: string,
) => {
    const api = {
        setPaddingMdSymbols_(mdSymbols: string[] | null) {
            draft.editorState_.paddingMdSymbols_ = mdSymbols;
            return this;
        },
        setStartCursorInfo_(cursorInfo?: CursorInfo | null) {
            if (!cursorInfo) return this;
            draft.editorState_.cursorInfo_ = {
                // Derive the span anchor against the post-edit tree (the data
                // behind same-block drift protection under collaboration, see
                // common/cursor/)
                start_: withSpanAnchor(cursorInfo, draft.renderData_),
                end_: null,
                source_: CursorSource.Model
            }
            this.updatePaddingMdSybolsAfterRender_(cursorInfo);
            return this;
        },
        updatePaddingMdSybolsAfterRender_(cursorInfo: CursorInfo) {
            const { uuid: uuid, offset: offset } = cursorInfo;

            const node = getRenderDataById(
                uuid,
                draft.renderData_,
            ) as ParentRenderData;
            if (!node) return;
            const { curNode: parseNode } = getNodeInfo(offset, node);

            if (parseNode && parseNode.mdSymbols_.length) {
                this.setPaddingMdSymbols_(parseNode.mdSymbols_);
            } else {
                const { curNode: nextNode } = getNodeInfo(offset + 1, node);
                if (nextNode && nextNode.mdSymbols_.length) {
                    this.setPaddingMdSymbols_(nextNode.mdSymbols_);
                } else {
                    this.setPaddingMdSymbols_(null);
                }
            }
            return this;
        },
        resetTextByUUID_(id: string, text: string) {
            const draftRenderData = draft.renderData_;
            let findCursorInfo: CursorInfo | null = null;
            const newParsedData = parseMarkdown(text, {
                onCursorFound_: (cursorInfo: CursorInfo) => {
                    findCursorInfo = cursorInfo;
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            // The markdown-text → tree seam: pre-split large plain-text spans.
            // The first time an existing single-span paragraph is edited, the
            // merge takes its changed region from the already-split new parse →
            // one edit restores sentence-level granularity in place (untouched
            // paragraphs stay coarse-grained at zero cost).
            splitTextSpans(newParsedData);
            const parentAndIndex = getParentAndIndex(id, draftRenderData);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            const oldNode = parent.children_[index];

            // Span-preserving merge: when the first block of the new parse has
            // the same type as the old block (P / a Header of the same level) we
            // do not swap the whole block, only the changed region the character
            // diff found — the old span references and the old block's uuid_ are
            // kept verbatim (minimal immer patch / React skips unchanged spans /
            // fine-grained CRDT inside the paragraph). When the parse yields
            // several blocks (Enter splitting a paragraph / pasting several
            // paragraphs) the first block keeps its identity as usual and the
            // rest are spliced in after it — otherwise a split would give the
            // current block a new uuid, and two peers splitting the same
            // paragraph concurrently would each produce delete+insert, so the
            // CRDT merge duplicates that paragraph (the playground "Try"
            // paragraph-doubling incident).
            // After a successful merge, the cursor uuid the parser reported (a
            // node of the newly parsed tree) is remapped through the remap table
            // onto the retained old node (the first P/Header block, the inner P
            // of a table cell and a code block's PreCode are all in the table).
            const uuidRemap = new Map<string, string>();
            if (
                newParsedData.children_.length >= 1 &&
                mergeParsedBlock(
                    oldNode,
                    newParsedData.children_[0],
                    uuidRemap,
                )
            ) {
                if (newParsedData.children_.length > 1) {
                    parent.children_.splice(
                        index + 1,
                        0,
                        ...newParsedData.children_.slice(1),
                    );
                }
                const cursorInfo = findCursorInfo as CursorInfo | null;
                const mapped = cursorInfo && uuidRemap.get(cursorInfo.uuid);
                if (cursorInfo && mapped) {
                    findCursorInfo = {
                        uuid: mapped,
                        offset: cursorInfo.offset,
                    };
                }
            } else if (oldNode.htmlType_ === MarkdownType.li) {
                parent.children_.splice(
                    index,
                    1,
                    ...newParsedData.children_[0].children_!,
                );
            } else {
                parent.children_.splice(index, 1, ...newParsedData.children_);
            }
            // Autofill promotion — materialize the missing block separator.
            // chainProduceParsedData_ appends a trailing EmptyP(isAutoFill_)
            // after atomic blocks (Table/code/hr) WITHOUT a LineBrBr sibling
            // (while empty it serializes to "", so none is needed). When the
            // user types into it, the fresh parse replaces it with a real
            // block (EmptyP never merges) — but the `\n\n` between the atomic
            // block and the new content exists nowhere, so toMarkdown's
            // join("") would weld them: `| a | b |text`. Splice in the
            // LineBrBr that should have been there. EmptyP gate: the trailing
            // autofill is the only top-level autofill node; table-internal
            // autofill rows (TR/TD) must never trigger this. Skip when the
            // pre-sibling already is a separator (doc ending in `\n\n` parses
            // to `..., LineBrBr` before the autofill EmptyP is appended).
            if (
                oldNode.isAutoFill_ &&
                oldNode.htmlType_ === MarkdownType.EmptyP &&
                newParsedData.children_.length >= 1 &&
                index > 0 &&
                parent.children_[index - 1].htmlType_ !== MarkdownType.LineBr &&
                parent.children_[index - 1].htmlType_ !== MarkdownType.LineBrBr
            ) {
                parent.children_.splice(index, 0, {
                    htmlType_: MarkdownType.LineBrBr,
                    text_: "\n\n",
                    uuid_: uuid(),
                    mdSymbols_: [],
                    htmlProps_: {},
                });
            }
            if (findCursorInfo) {
                this.setStartCursorInfo_(findCursorInfo);
            } else {
                // debugger;
            }
            return this;
        },
        parsePreSibling_(uuid: string) {
            const parentAndIndex = getParentAndIndex(uuid, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            if (index > 0) {
                const pre = parent.children_[index - 1];
                const text = toMarkdown(pre);
                return this.resetTextByUUID_(pre.uuid_, text);
            }
            return this;
        },
        parseCurrrent_(id: string) {
            const current = getRenderDataById(id, draft.renderData_);
            if (!current) return this;
            const text = toMarkdown(current);
            return this.resetTextByUUID_(id, text);
        },
        moveCursorToSibling_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            let preIndex = index - 1;
            if (
                parent.children_[preIndex].htmlType_ ===
                    MarkdownType.LineBrBr ||
                parent.children_[preIndex].htmlType_ === MarkdownType.LineBr
            ) {
                preIndex = index - 2;
            }
            if (parent && parent.children_) {
                const cursorNode = parent.children_[preIndex];
                const cursorInfo = getCursorInfoByParseData(cursorNode);
                if (cursorInfo) {
                    this.setStartCursorInfo_(cursorInfo);
                }
            }
            return this;
        },
        moveCursorToNextSibling_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            let nextIndex = index + 1;
            if (
                parent.children_[nextIndex].htmlType_ ===
                    MarkdownType.LineBrBr ||
                parent.children_[nextIndex].htmlType_ === MarkdownType.LineBr
            ) {
                nextIndex = index + 2;
            }

            if (
                parent &&
                parent.children_
            ) {
                const cursorNode = parent.children_[nextIndex];
                const cursorInfo = getCursorInfoByParseData(cursorNode);
                if (cursorInfo) {
                    this.setStartCursorInfo_({
                        ...cursorInfo,
                        offset: 0,
                    });
                }
            }
            return this;
        },
        removeFromParent_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            parent.children_?.splice(index, 1);

            const pre = parent.children_.at(-1);
            if (
                pre &&
                (pre.htmlType_ === MarkdownType.LineBr ||
                    pre.htmlType_ === MarkdownType.LineBrBr)
            ) {
                parent.children_?.splice(index - 1, 1);
            }

            return this;
        },
        removeFromParentPro_(id: string) {
            const handle = (id: string) => {
                const parentAndIndex = getParentAndIndex(id, draft.renderData_);
                if (!parentAndIndex) return;
                const { parent, index } = parentAndIndex;

                if (parent.htmlType_ === MarkdownType.li) {
                    const parentAndIndexOfList = getParentAndIndex(
                        parent.uuid_,
                        draft.renderData_,
                    );
                    if (parentAndIndexOfList) {
                        const { parent: listParent, index: liIndex } =
                            parentAndIndexOfList;
                        listParent.children_.splice(liIndex, 1);
                    }
                } else {
                    parent.children_.splice(index, 1);
                }
            };

            handle(id);

            return this;
        },
        liToPreSiblingChild_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            const liData = parent.children_[index];
            if (
                index == 0 ||
                (liData.htmlType_ !== MarkdownType.li &&
                    liData.htmlType_ !== MarkdownType.CheckBoxLi) ||
                (parent.htmlType_ !== MarkdownType.Ul &&
                    parent.htmlType_ !== MarkdownType.Ol)
            )
                return this;
            const [empty] =
                parent.htmlType_ == MarkdownType.Ul
                    ? createEmptyUL()
                    : createEmptyOl();
            empty.children_ = [liData];
            empty.htmlProps_["data-mark"] = parent.htmlProps_["data-mark"];
            const lineBr: RenderData = {
                htmlType_: MarkdownType.LineBr,
                text_: "\n",
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            };
            parent.children_[index - 2].children_?.push(lineBr, empty);
            parent.children_.splice(index - 1, 2);
            return this;
        },
        deleteChild_(id: string, childIndex: number) {
            const renderData = getRenderDataById(id, draft.renderData_);
            if (!renderData) return this;

            renderData.children_?.splice(childIndex, 1);

            return this;
        },
        toggleCheckbox_(id: string) {
            const renderData = getRenderDataById(id, draft.renderData_);
            if (!renderData) return this;

            if (renderData.htmlProps_.checked !== undefined) {
                renderData.htmlProps_.checked = !renderData.htmlProps_.checked;
                renderData.uuid_ = uuid();
            }
            return this;
        },
        toggleSummary_(summaryId: string) {
            const parentAndIndex = getParentAndIndex(
                summaryId,
                draft.renderData_,
            );
            if (!parentAndIndex) return this;
            const { parent } = parentAndIndex;

            if (parent.htmlProps_.open !== undefined) {
                parent.htmlProps_.open = !parent.htmlProps_.open;
                parent.uuid_ = uuid();
                if (parent.htmlProps_.open) {
                    parent.children_[0].text_ = "<details open>";
                } else {
                    parent.children_[0].text_ = "<details>";
                }
            }
            return this;
        },
        addNextEmptySiblingByUUID_(id: string, insertCursor = false) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            const [emptyP, cursorInfo] = createEmptyP();

            const data = {
                ...parent.children_[index],
                children_:
                    parent.children_[index].htmlType_ ===
                    MarkdownType.CheckBoxLi
                        ? [
                              {
                                  htmlType_: MarkdownType.CheckBoxLabel,
                                  uuid_: uuid(),
                                  mdSymbols_: [],
                                  htmlProps_: {
                                      contentEditable: false,
                                  },
                                  children_: [
                                      {
                                          htmlType_:
                                              MarkdownType.CheckboxesInput,
                                          text_: "",
                                          uuid_: uuid(),
                                          mdSymbols_: [],
                                          htmlProps_: {
                                              checked: false,
                                          },
                                      },
                                      {
                                          htmlType_: MarkdownType.Plain,
                                          text_: "",
                                          uuid_: uuid(),
                                          mdSymbols_: [],
                                          htmlProps_: {},
                                      },
                                  ],
                              },
                              emptyP,
                          ]
                        : [emptyP],
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            } as ParentRenderData;

            const lineBr: RenderData = {
                htmlType_: MarkdownType.LineBr,
                text_: "\n",
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            };

            parent.children_.splice(index + 1, 0, lineBr, data);

            if (insertCursor) {
                this.setStartCursorInfo_(cursorInfo);
            }

            return this;
        },
        // Copy the previous sibling's type and add text to new sibling's children
        addNextSiblingByUUID_(id: string, text: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            const parseData = parseMarkdown(text, {
                onCursorFound_: (cursorInfo: CursorInfo) => {
                    this.setStartCursorInfo_(cursorInfo);
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(parseData);

            const result = [];

            const data = {
                ...parent.children_[index],
                children_:
                    parent.children_[index].htmlType_ ===
                    MarkdownType.CheckBoxLi
                        ? [
                              {
                                  htmlType_: MarkdownType.CheckBoxLabel,
                                  uuid_: uuid(),
                                  mdSymbols_: [],
                                  htmlProps_: {
                                      contentEditable: false,
                                  },
                                  children_: [
                                      {
                                          htmlType_:
                                              MarkdownType.CheckboxesInput,
                                          text_: "",
                                          uuid_: uuid(),
                                          mdSymbols_: [],
                                          htmlProps_: {
                                              checked: false,
                                          },
                                      },
                                      {
                                          htmlType_: MarkdownType.Plain,
                                          text_: "",
                                          uuid_: uuid(),
                                          mdSymbols_: [],
                                          htmlProps_: {},
                                      },
                                  ],
                              },
                              ...parseData.children_,
                          ]
                        : [...parseData.children_],
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            } as ParentRenderData;

            if (
                parent.children_[index].htmlType_ === MarkdownType.CheckBoxLi ||
                parent.children_[index].htmlType_ === MarkdownType.li
            ) {
                const lineBr: RenderData = {
                    htmlType_: MarkdownType.LineBr,
                    text_: "\n",
                    uuid_: uuid(),
                    mdSymbols_: [],
                    htmlProps_: {},
                };
                result.push(lineBr);
            }

            result.push(data);

            parent.children_.splice(index + 1, 0, ...result);

            return this;
        },
        // Add parsed text below without copying any type, use the parsed type as is
        addNextByUUID_(id: string, text: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            const parseData = parseMarkdown(text, {
                onCursorFound_: (cursorInfo: CursorInfo) => {
                    this.setStartCursorInfo_(cursorInfo);
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(parseData);

            const lineBrBr: RenderData = {
                htmlType_: MarkdownType.LineBrBr,
                text_: "\n\n",
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            };

            parent.children_.splice(
                index + 1,
                0,
                lineBrBr,
                ...parseData.children_,
            );

            return this;
        },
        // —— Selection delete/replace: scoped reparse + boundary reconciliation ——
        // The old implementation was "toMarkdown the whole document →
        // parseMarkdown the whole document → replace the whole tree": even the
        // root reference changed and every block got a brand-new uuid → the CRDT
        // diff read it as a whole-document delete+insert and React rebuilt
        // everything. The blast radius is now limited to the top-level children
        // range [start..end] covered by the selection's two endpoints:
        // - children outside the range (root itself included) keep their
        //   references → zero immer patches, invisible to outer observers;
        // - start === end (a single-block selection, by far the most common):
        //   serialize that block locally and go straight through
        //   resetTextByUUID_ — mergeParsedBlock's span-reference reuse / block
        //   uuid preservation / cursor remapping / splitTextSpans are all
        //   inherited, so deleting two characters produces only the minimal op
        //   for the spans it touched;
        // - start < end (a cross-block selection): serialize only the
        //   children[start..end] slice (LineBr/LineBrBr separator nodes carry
        //   their own \n\n text, so the slice is self-consistent), parse the
        //   fragment after the deletion, and run its first block against the old
        //   child[start] through mergeParsedBlock (the same "merge when the first
        //   block matches" semantics as resetTextByUUID_) → child[start] keeps
        //   its uuid plus the leading span references, and the remaining old
        //   blocks are clean deletes — which is exactly "the first block was
        //   edited, the blocks in between were deleted";
        // - an endpoint that maps to no top-level child / a missing marker / a
        //   fragment that parses to nothing → fall back to fullReparseSelect_
        //   (byte-for-byte equivalent to the old implementation).
        applySelectEdit_(cursorInfo: CursorInfo[], insertText: string) {
            const root = draft.renderData_;
            const iA = topLevelIndexOf(cursorInfo[0].uuid, root);
            const iB = topLevelIndexOf(cursorInfo[1].uuid, root);
            if (iA === -1 || iB === -1) {
                return this.fullReparseSelect_(cursorInfo, insertText);
            }
            const start = Math.min(iA, iB);
            const end = Math.max(iA, iB);

            if (start === end) {
                const block = root.children_[start];
                const text = toMarkdown(block, cursorInfo);
                const array = text.split(CursorMarker);
                // Both endpoints sit inside this block, so there is at least
                // one marker (a selection within a single node injects two)
                if (array.length < 2) {
                    return this.fullReparseSelect_(cursorInfo, insertText);
                }
                const before = array[0] + insertText;
                const after = array[array.length - 1];
                const newText =
                    before +
                    CursorMarker +
                    padIfEmptyCodeBlock(before, after) +
                    after;
                return this.resetTextByUUID_(block.uuid_, newText);
            }

            const slice = root.children_.slice(start, end + 1);
            const text = slice
                .map((child) => toMarkdown(child, cursorInfo))
                .join("");
            const array = text.split(CursorMarker);
            // In a cross-block selection the two markers belong to different
            // blocks; both must have been injected
            if (array.length < 3) {
                return this.fullReparseSelect_(cursorInfo, insertText);
            }
            const before = array[0] + insertText;
            const after = array[array.length - 1];
            const newText =
                before +
                CursorMarker +
                padIfEmptyCodeBlock(before, after) +
                after;

            let findCursorInfo: CursorInfo | null = null;
            const fragment = parseMarkdown(newText, {
                onCursorFound_: (ci: CursorInfo) => {
                    findCursorInfo = ci;
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(fragment);
            if (!fragment.children_.length) {
                return this.fullReparseSelect_(cursorInfo, insertText);
            }

            const oldFirst = root.children_[start];
            const uuidRemap = new Map<string, string>();
            if (mergeParsedBlock(oldFirst, fragment.children_[0], uuidRemap)) {
                root.children_.splice(
                    start + 1,
                    end - start,
                    ...fragment.children_.slice(1),
                );
                // A successful merge = the retained old node stands in for the
                // newly parsed one, so the cursor uuid the parser reported (a
                // node of the new tree) is mapped back onto the retained tree
                // through the remap table (as in resetTextByUUID_)
                const ci = findCursorInfo as CursorInfo | null;
                const mapped = ci && uuidRemap.get(ci.uuid);
                if (ci && mapped) {
                    findCursorInfo = {
                        uuid: mapped,
                        offset: ci.offset,
                    };
                }
            } else {
                root.children_.splice(
                    start,
                    end - start + 1,
                    ...fragment.children_,
                );
            }
            this.setStartCursorInfo_(findCursorInfo);
            return this;
        },
        // Fallback path: serialize the whole document, reparse it in full and
        // replace the whole tree — byte-for-byte equivalent to how
        // deleteSelect_/replaceSelect_ behaved before the scoped rework. Used
        // only in abnormal cases, such as a selection endpoint that cannot be
        // located.
        fullReparseSelect_(cursorInfo: CursorInfo[], insertText: string) {
            const text = toMarkdown(draft.renderData_, cursorInfo);
            const array = text.split(CursorMarker);
            const before = array[0] + insertText;
            const after = array[array.length - 1];
            const newText =
                before +
                CursorMarker +
                padIfEmptyCodeBlock(before, after) +
                after;

            const reparsedDoc = parseMarkdown(newText, {
                onCursorFound_: (cursorInfo: CursorInfo) => {
                    this.setStartCursorInfo_(cursorInfo);
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(reparsedDoc);
            draft.renderData_ = reparsedDoc;
            return this;
        },
        deleteSelect_(cursorInfo: CursorInfo[]) {
            return this.applySelectEdit_(cursorInfo, "");
        },
        // Marker-free scoped reparse used by the batch replace API
        // (EditorStore.replaceRanges/replaceText): replace top-level children
        // [startIndex, startIndex + deleteCount) with the parse of `newText`.
        // Same identity discipline as applySelectEdit_'s cross-block branch —
        // the first fragment block merges into the old first child when the
        // types line up (uuid + untouched span references preserved), the
        // rest splice in as fresh nodes. Unlike the selection paths the range
        // is addressed by child index, not CursorMarker injection, because
        // replace offsets may fall inside serialization scaffolding (list
        // markers, table pipes, fences) that no cursor coordinate can express.
        //
        // reportCursor_: opt-in for callers that DO embed a CursorMarker in
        // `newText` (structural ops like addTableRow/addTableColumn, which
        // know exactly where the caret should land in the regenerated block).
        // The parser-reported cursor is forwarded to setStartCursorInfo_,
        // with the same first-block uuid remap the selection path does.
        replaceTopLevelSlice_(
            startIndex: number,
            deleteCount: number,
            newText: string,
            reportCursor_ = false,
        ) {
            const root = draft.renderData_;
            if (!newText) {
                root.children_.splice(startIndex, deleteCount);
                return this;
            }
            let foundCursor: CursorInfo | null = null;
            const fragment = parseMarkdown(newText, {
                ...(reportCursor_
                    ? {
                          onCursorFound_: (ci: CursorInfo) => {
                              foundCursor = ci;
                          },
                      }
                    : {}),
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(fragment);
            // Edge-EmptyP artifacts: a fragment starting/ending with newlines
            // parses standalone as if those newlines bordered the document
            // edge, emitting an EmptyP the full-document parse would NOT have
            // when the neighboring kept child is a content block (the
            // newlines then just separate it from the fragment). Drop those.
            // When the kept neighbor is a separator the EmptyP is a real
            // blank paragraph — keep it.
            const keptBefore =
                startIndex > 0 ? root.children_[startIndex - 1] : null;
            const keptAfter =
                startIndex + deleteCount < root.children_.length
                    ? root.children_[startIndex + deleteCount]
                    : null;
            const isSep = (n: RenderData | ParentRenderData | null) =>
                !!n &&
                (n.htmlType_ === MarkdownType.LineBr ||
                    n.htmlType_ === MarkdownType.LineBrBr);
            if (
                keptBefore &&
                !isSep(keptBefore) &&
                fragment.children_[0]?.htmlType_ === MarkdownType.EmptyP
            ) {
                fragment.children_.shift();
            }
            if (
                keptAfter &&
                !isSep(keptAfter) &&
                fragment.children_.at(-1)?.htmlType_ === MarkdownType.EmptyP
            ) {
                fragment.children_.pop();
            }
            if (!fragment.children_.length) {
                root.children_.splice(startIndex, deleteCount);
                return this;
            }
            const oldFirst = root.children_[startIndex];
            const uuidRemap = new Map<string, string>();
            if (
                oldFirst &&
                mergeParsedBlock(oldFirst, fragment.children_[0], uuidRemap)
            ) {
                root.children_.splice(
                    startIndex + 1,
                    deleteCount - 1,
                    ...fragment.children_.slice(1),
                );
                // A successful merge = the retained old node stands in for the
                // newly parsed one, so the cursor uuid is mapped back onto the
                // retained tree through the remap table (as in
                // applySelectEdit_).
                const ci = foundCursor as CursorInfo | null;
                const mapped = ci && uuidRemap.get(ci.uuid);
                if (ci && mapped) {
                    foundCursor = { uuid: mapped, offset: ci.offset };
                }
            } else {
                root.children_.splice(
                    startIndex,
                    deleteCount,
                    ...fragment.children_,
                );
            }
            if (reportCursor_ && foundCursor) {
                this.setStartCursorInfo_(foundCursor);
            }
            return this;
        },
        // Replace the selection: drop the selected content, insert insertText at
        // the deletion point, leave the caret after insertText.
        // Shares its implementation with deleteSelect_ (applySelectEdit_); only
        // the middle segment is swapped for insertText.
        // An empty insertText (e.g. `e.data ?? ""`) degrades to deleteSelect_ and
        // can empty a code block just the same — the padIfEmptyCodeBlock guard
        // lives inside applySelectEdit_.
        replaceSelect_(cursorInfo: CursorInfo[], insertText: string) {
            this.applySelectEdit_(cursorInfo, insertText);
            // The selection has collapsed to a single caret: clear end, or
            // UseCursor would restore a leftover selection from the stale end
            draft.editorState_.cursorInfo_.end_ = null;
            return this;
        },
        // Inline formatting (bold / italic / strikethrough / highlight).
        // cursorInfo holds the selection's two endpoints (same block, offsets
        // already adjusted). toMarkdown's third argument flips the mark inside
        // that block according to `op` and brackets the range with two
        // CursorMarkers; after the reparse, onCursorFound reports the two markers
        // back in order as start/end, so the selection survives intact and marks
        // can be toggled back to back (bold first, then italic).
        formatInline_(cursorInfo: CursorInfo[], format: InlineFormat) {
            const text = toMarkdown(draft.renderData_, cursorInfo, format);
            const cursors: CursorInfo[] = [];
            const reparsedDoc = parseMarkdown(text, {
                onCursorFound_: (cursorInfo: CursorInfo) => {
                    cursors.push(cursorInfo);
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(reparsedDoc);
            draft.renderData_ = reparsedDoc;
            if (cursors[0]) this.setStartCursorInfo_(cursors[0]);
            // With a single marker (the degraded path for non-P blocks) end is
            // empty → collapse to a caret so no ghost selection is left behind
            draft.editorState_.cursorInfo_.end_ = cursors[1] ?? null;
            return this;
        },
        addEmptyPToPre_(id: string, insertCursor = false) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            const [emptyP, cursorInfo] = createEmptyP();
            const lineBrBr: RenderData = {
                htmlType_: MarkdownType.LineBrBr,
                text_: "\n\n",
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            };
            parent.children_.splice(index, 0, emptyP, lineBrBr);
            if (insertCursor) {
                this.setStartCursorInfo_(cursorInfo);
            }
            return this;
        },
        addEmptyPToNext_(id: string, insertCursor = false) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            const [emptyP, cursorInfo] = createEmptyP();
            const lineBrBr: RenderData = {
                htmlType_: MarkdownType.LineBrBr,
                text_: "\n\n",
                uuid_: uuid(),
                mdSymbols_: [],
                htmlProps_: {},
            };
            parent.children_.splice(index + 1, 0, lineBrBr, emptyP);
            if (insertCursor) {
                this.setStartCursorInfo_(cursorInfo);
            }
            return this;
        },
        moveChildrenToPreSibling_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            if (index > 0 && parent.children_[index].children_) {
                if (
                    parent.children_[index].children_[0].htmlType_ ===
                    MarkdownType.CheckBoxLabel
                ) {
                    parent.children_[index - 1].children_?.push(
                        ...parent.children_[index].children_.slice(1),
                    );
                    parent.children_.splice(index, 1);
                } else {
                    const lineBrBr: RenderData = {
                        htmlType_: MarkdownType.LineBrBr,
                        text_: "\n\n",
                        uuid_: uuid(),
                        mdSymbols_: [],
                        htmlProps_: {},
                    };
                    const pre = parent.children_[index - 1];
                    parent.children_[index - 2].children_?.push(
                        lineBrBr,
                        ...parent.children_[index].children_,
                    );
                    const cursorNode = parent.children_[index].children_.at(-1);
                    const cursorInfo = getCursorInfoByParseData(cursorNode);
                    this.setStartCursorInfo_(
                        cursorInfo ? { ...cursorInfo, offset: 0 } : null,
                    );
                    if (
                        pre &&
                        (pre.htmlType_ === MarkdownType.LineBr ||
                            pre.htmlType_ === MarkdownType.LineBrBr)
                    ) {
                        parent.children_?.splice(index - 1, 2);
                    }
                }
            }
            return this;
        },
        moveNonFirstLiChildrenToNextLi_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            const liChildren = parent.children_[index].children_;

            if (
                index < parent.children_.length - 1 &&
                liChildren &&
                liChildren.length > 1
            ) {
                const moveChildren =
                    liChildren[0].htmlType_ === MarkdownType.CheckBoxLabel
                        ? liChildren.splice(2)
                        : liChildren.splice(1);
                parent.children_[index + 1].children_?.push(...moveChildren);
            }
            return this;
        },
        // Scenario: Backspace pressed with the caret at offset 0 of the first
        // child of the first li of a list (ul/ol).
        // Behaviour: "lift" that li's children out in front of the ul (as its
        // preceding siblings) and delete the li.
        // Effect: the first list item leaves the list and turns back into an
        // ordinary paragraph (and if it was the only item, the whole list is
        // dissolved).
        // `id` is the li's uuid, `parent` is the ul, `grandParent` is whatever
        // contains the ul.
        moveChildrenToParentPreSibling_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            const grandParentAndIndex = getParentAndIndex(
                parent.uuid_,
                draft.renderData_,
            );
            if (!grandParentAndIndex) return this;
            const { parent: grandParent, index: indexInParent } =
                grandParentAndIndex;

            if (parent.children_[index].children_) {
                if (
                    parent.children_[index].children_[0].htmlType_ ===
                    MarkdownType.CheckBoxLabel
                ) {
                    if (parent.children_.length === 1) {
                        grandParent.children_.splice(indexInParent, 1);
                    }
                    // A CheckBoxLi's first child is the CheckBoxLabel (the
                    // checkbox itself); dissolving the item drops it and lifts
                    // only the real content nodes after it.
                    grandParent.children_.splice(
                        indexInParent,
                        0,
                        ...parent.children_[index].children_.slice(1),
                    );
                    const cursorInfo = getCursorInfoByParseData(
                        parent.children_[index].children_[1],
                    );
                    if (cursorInfo) {
                        this.setStartCursorInfo_({ ...cursorInfo, offset: 0 });
                    }
                    // Remove the now-hollowed li from the ul.
                    parent.children_.splice(index, 1);
                } else if (parent.htmlType_ === MarkdownType.Blockquote) {
                    if (parent.children_.length === 1) {
                        grandParent.children_.splice(indexInParent, 1);
                    }
                    // Ordinary li: insert all of its children before the ul's
                    // position in grandParent.
                    grandParent.children_.splice(
                        indexInParent,
                        0,
                        parent.children_[index],
                    );
                    const cursorInfo = getCursorInfoByParseData(
                        parent.children_[index],
                    );
                    if (cursorInfo) {
                        this.setStartCursorInfo_({ ...cursorInfo, offset: 0 });
                    }
                } else {
                    if (parent.children_.length === 1) {
                        grandParent.children_.splice(indexInParent, 1);
                    }
                    // Ordinary li: insert all of its children before the ul's
                    // position in grandParent.
                    grandParent.children_.splice(
                        indexInParent,
                        0,
                        ...parent.children_[index].children_,
                    );
                    const cursorInfo = getCursorInfoByParseData(
                        parent.children_[index].children_[0],
                    );
                    if (cursorInfo) {
                        this.setStartCursorInfo_({ ...cursorInfo, offset: 0 });
                    }
                    // Remove the now-hollowed li from the ul.
                    parent.children_.splice(index, 1);
                }
            }
            return this;
        },
        moveChildrenToPreSiblingLastRender_(id: string) {
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            if (index > 0 && parent.children_[index].children_) {
                const preSlibling = parent.children_[index - 1];
                const lastRenderData = getLastRender(preSlibling);
                if (lastRenderData) {
                    lastRenderData.children_.push(
                        ...parent.children_[index].children_,
                    );
                }
                parent.children_.splice(index, 1);
            }

            return this;
        },
        moveToPreSiblingLastRender_(id: string, insertCursor = false) {
            let newText;
            let lastRenderDataId;
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;
            if (index > 0 && parent.children_[index].children_) {
                const draftPreSlibling = parent.children_[index - 1];
                if (
                    draftPreSlibling.htmlType_ === MarkdownType.LineBr ||
                    draftPreSlibling.htmlType_ === MarkdownType.LineBrBr
                ) {
                    if (parent.children_[index - 2]) {
                        const preSlibling = parent.children_[index - 2];
                        const lastRenderData = getLastRender(preSlibling);
                        if (lastRenderData) {
                            const lastText = toMarkdown(lastRenderData);
                            const curText = toMarkdown(parent.children_[index]);
                            newText =
                                lastText +
                                (insertCursor ? CursorMarker : "") +
                                curText;
                            lastRenderDataId = lastRenderData.uuid_;
                        }
                        parent.children_.splice(index, 2);
                    }
                } else {
                    const preSlibling = draftPreSlibling;
                    const lastRenderData = getLastRender(preSlibling);
                    if (lastRenderData) {
                        const lastText = toMarkdown(lastRenderData);
                        const curText = toMarkdown(parent.children_[index]);
                        newText =
                            lastText +
                            (insertCursor ? CursorMarker : "") +
                            curText;
                        lastRenderDataId = lastRenderData.uuid_;
                    }
                    parent.children_.splice(index, 1);
                }
            }
            if (lastRenderDataId) {
                return this.resetTextByUUID_(lastRenderDataId, newText || "");
            }
            return this;
        },
        insertImage_(
            startCursorInfo: CursorInfo,
            url: string,
            altText: string,
            insertCursor = false,
        ) {
            const renderData = getRenderDataById(
                startCursorInfo.uuid,
                draft.renderData_,
            );
            if (!renderData) return this;

            const text = toMarkdown(renderData);
            const preText = text.slice(0, startCursorInfo.offset);
            const afterText = text.slice(startCursorInfo.offset);

            const newText =
                preText +
                `![${altText}](${url})${insertCursor ? CursorMarker : ""}` +
                afterText;
            this.resetTextByUUID_(startCursorInfo.uuid, newText);
            return this;
        },
        removeSlash_(id: string, onIdChange: (id: string) => void) {
            const renderData = getRenderDataById(id, draft.renderData_);
            if (!renderData) return this;
            const text = CursorMarker + toMarkdown(renderData).slice(1);

            const newParsedData = parseMarkdown(text, {
                onCursorFound_: (cursorInfo: CursorInfo) => {
                    this.setStartCursorInfo_(cursorInfo);
                },
                codeTokenizer_: codeTokenizer,
                inlineRules_: inlineRules,
                imgGroupSeparators_: imgGroupSeparators,
            });
            splitTextSpans(newParsedData);
            const parentAndIndex = getParentAndIndex(id, draft.renderData_);
            if (!parentAndIndex) return this;
            const { parent, index } = parentAndIndex;

            const newData = newParsedData.children_[0];

            if (!newData) return this;

            parent.children_.splice(index, 1, newData);

            onIdChange?.(newData.uuid_);
            return this;
        },
    };
    return api;
};

export type EditorStateChainable = ReturnType<typeof editorStateChainable>;
