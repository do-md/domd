// Hand-maintained public type surface for this package.
//
// The published bundle ships only index.js / index.cjs / style.css. tsc/terser
// would mangle every `_`-suffixed member to a fresh name each build, so we do
// NOT auto-generate declarations — we curate them here by hand and copy this
// file to dist/index.d.ts on build (see vite.config.ts copyDistAssets).
//
// Rule: only expose the stable public surface. Anything terser renames (members
// ending in `_`) must be re-typed under a stable, non-`_` name, NOT shipped as-is.

import type { FC, ReactNode, RefObject } from "react";

export interface EditorDomContextValue {
    textAreaDomRef: RefObject<HTMLDivElement | null>;
}

/** Opaque parsed-document handle. Treat as a black box; only feed it back
 *  into the kernel (e.g. toMarkdown). */
export interface RenderData {
    readonly __domdRenderData: unique symbol;
}

/** Returned by useEditor(). Only the public methods consumers use are typed. */
export interface Editor {
    focus(): void;
    aiInsertInCursor(text: string): void;
    readonly editorStore: EditorStoreApi;
}

/** Embed/input mode: which key binds "real newline". When set, bare Enter
 *  yields to the host (fires onEnter) and newline moves to this key. */
export type NewlineKey = "Shift+Enter" | "Mod+Enter";

/** A point in the document: which block (uuid_) and the character offset
 *  into that block's serialized markdown. */
export interface CursorInfo {
    uuid: string;
    offset: number;
}

/** Snapshot of selection / cursor context. Mirrors the Rust-side struct
 *  serialized over the CLI socket — keep field names in sync. */
export interface SelectionState {
    has_selection: boolean;
    selected_text: string;
    before: string;
    after: string;
    before_truncated: boolean;
    after_truncated: boolean;
}

/** Returned by useEditorStoreApi(). The full surface is intentionally
 *  hidden — only the curated public members are typed. */
export interface EditorStoreApi {
    /** Current selection start (caret when no range). null before the user
     *  places a cursor. Reactive — read via useEditorStore to re-render on
     *  change. */
    startCursorInfo: CursorInfo | null;
    isEditable:boolean;
    /** True while an IME composition is in progress. Reactive. */
    duringComposition: boolean;
    resetMD(md: string): void;
    toMarkdown(): string;
    insertImage(url: string, altText?: string): void;
    insertText(text: string): void;
    /** Plain-text title derived from the first block (stripped markdown
     *  syntax). Empty when the doc is empty. Caller must sanitize before
     *  using as a filename. */
    getTitle(): string;
    /** Read the current selection / cursor snapshot. Used by the CLI
     *  server to answer `domd-cli selection` queries. */
    getSelectionState(contextChars?: number): SelectionState;
    /** Listen for any store change. Returns the unsubscribe function.
     *  Inherited from BaseStore. */
    subscribe(
        listener: (newState: unknown, prevState: unknown) => void,
    ): () => void;
}

export interface DOMDProviderProps {
    children?: ReactNode;
    editable?: boolean;
    initMd?: string;
    placeholder?: string;
    imageLoader?: (src: string) => Promise<string>;
    codeTokenizer?: (code: string, lang?: string) => unknown[];
    newlineKey?: NewlineKey;
    onEnter?: (store: EditorStoreApi, event: KeyboardEvent) => void;
}

export const DOMD: FC;
export const DOMDProvider: FC<DOMDProviderProps>;

export function useEditor(): Editor | null;
export function useEditorStoreApi(): EditorStoreApi | null;
/** Selector hook. Subscribes to store changes (via useSyncExternalStore)
 *  and returns the selected slice, re-rendering only when that slice
 *  changes. The selector receives the live store instance. Must be called
 *  within a DOMDProvider. Prefer this over useEditorStoreApi when you want
 *  reactive reads; use useEditorStoreApi for imperative one-off calls. */
export function useEditorStore<T>(selector: (store: EditorStoreApi) => T): T;
export function useRenderData(): RenderData;
export function useEditorDom(): EditorDomContextValue;
export function toMarkdown(data: RenderData): string | null;
