/*!
 * DoMD Core (@do-md/core-react)
 * Copyright (C) 2026 Jayden Wang
 *
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License version 3, as published by the
 * Free Software Foundation, together with the additional permissions granted
 * under section 7 of that license in LICENSE-EXCEPTIONS.md.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details: <https://www.gnu.org/licenses/>.
 */

// Core components and provider
export { DOMD, DOMDProvider } from "./editor/render/react/components";
export { useEditor } from "./editor/render/react/hooks/useEditor";
export { EditorStore, useEditorStore, useEditorStoreApi } from "./editor/store";
// useEditorStoreApi() returns the EditorStore instance itself; EditorStoreApi is the
// name it goes by in the docs and in host code (the hand-written d.ts from the
// closed-source era used exactly that name), kept here as a type alias.
export type { EditorStore as EditorStoreApi } from "./editor/store";
export { useRenderData } from "./editor/render/react/hooks/useRenderData";
export { useEditorDom } from "./editor/render/react/hooks/useEditorDom";
// State-first toolbar surface: reactive isActive/can per inline mark
// (bold/italic/strike/highlight/underline) — bind UI, no command queries.
export { useFormatState } from "./editor/render/react/hooks/useFormatState";
// Scroll memory is kernel-internal and always on (mounted by <DOMD/>, scroll
// container auto-detected): the store carries a ScrollAnchor snapshot at all
// times, and a view mounting over a store that already has one restores it
// once. Hosts interact through store.scrollAnchor / setScrollAnchor only —
// e.g. persist it and re-inject before mounting to resume a session.

// Type exports
export type {
    DOMDProps,
    DOMDRef,
    EditorMode,
    FormatState,
    MarkFormatState,
    InlineFormatMark,
    ImageLoader,
    InlineRule,
    InlineRuleVariant,
    InlineRuleParams,
    InlineRuleComponentProps,
    NewlineKey,
    AnyRenderData,
    ParentRenderData,
    RenderData,
    RenderElementProps,
    SelectionState,
    StoreConstructorProps,
    CursorInfo,
    ScrollAnchor,
    EditorDomContextValue,
} from "./editor/type";

// Declarative inline syntax: the shipped default rule set (== highlight),
// composable by hosts: `inlineRules={[...defaultInlineRules, mySupRule]}`
export { defaultInlineRules } from "./data-parse/inline-rules";

// View-only decoration contract for inline-rule `component` renders: spread
// `viewOnlyProps` on badges/icons so they never enter the text pipeline.
export { viewOnlyProps } from "./editor/render/props/viewOnlyProps";
export { DATA_VIEW_ONLY } from "./data-parse/constant";

// Enum exports
export { MarkdownType } from "./editor/type/enum";

// Renderer component (for plugin use)
export { default as Renderer } from "./editor/render/react/components/Renderer";

// Toolkit for renderComponent host components (generic — identical for every node
// type): RenderChildren renders a node's editable content (with the kernel's key
// discipline); the two prop builders are the same ones kernel elements use — spread
// them onto the host root element to keep render-id / cursor mapping alive.
export { default as RenderChildren } from "./editor/render/react/components/Renderer/RenderChildren";
export { getRenderElementProps } from "./editor/render/props/getRenderElementProps";
export { getSpanRenderIdProps } from "./editor/render/props/getSpanRenderIdProps";

// DOM-virtualization seam: a policy layer (e.g. @do-md/virtual) computes a
// RenderWindow from scroll position + measured heights and provides it
// through RenderWindowContext; RootElement then renders only that window of
// top-level blocks (plus kernel-forced pins: cursor block, DOM selection
// endpoints, tail autofill) with contentEditable=false spacers standing in
// for the rest. No provider / null value = the exact non-virtualized render
// path. The pure plan math is exported for headless verification.
export { RenderWindowContext } from "./editor/render/react/context";
export {
    computeRenderWindowPlan,
    buildRenderWindowPlan,
    resolveTopLevelIndex,
} from "./editor/render/window/plan";
export type {
    RenderWindow,
    RenderWindowSegment,
} from "./editor/render/window/plan";

// Utility exports
export { toMarkdown } from "./editor/model/serialize/toMarkdown";
// Every layer that binds a Mod+<letter> shortcut needs the same layout-correct
// test, so the kernel owns it rather than each host reinventing `e.code`.
export { matchesLetterKey } from "./editor/controller/lib/matchesLetterKey";

// Batch replace primitives (AI editing / external diff reconcile)
export type {
    RangeEdit,
    TextEdit,
    ReplaceResult,
    ReplaceEditResult,
    ReplaceFailureReason,
} from "./editor/model/replace/plan";

// Programmatic caret/selection placement (addressing mirrors the replace API)
export type {
    SelectionTarget,
    SelectionSearchTarget,
    SelectionRangeTarget,
    SelectionResult,
    ResolvedRange,
    ResolvedRangeAnchor,
} from "./editor/model/selection/resolve";

// RenderData sync seam (for CRDT / persistence plugins; stable public keys, immune
// to mangling)
export {
    serializeRenderData,
    deserializeRenderData,
    diffRenderData,
    applyRenderDataOpsToDraft,
} from "./editor/model/sync/renderDataOps";
export type {
    SerializedRenderData,
    RenderDataOp,
    CursorSnapshot,
} from "./editor/model/sync/renderDataOps";
