// Ambient module declaration for the closed-source `@do-md/react` kernel.
//
// The published bundle ships only index.js / index.cjs / style.css — no .d.ts.
// This file declares the public surface that this app actually consumes.
// Keep it minimal: only expose what callers in apps/domd actually use.

declare module "@do-md/react" {
    import type { ReactNode } from "react";

    /** Opaque parsed-document handle. Treat as a black box; only feed it back
     *  into the kernel (e.g. toMarkdown). */
    export interface RenderData {
        readonly __domdRenderData: unique symbol;
    }

    /** Returned by useEditor(). Only public methods used by the app are typed. */
    export interface Editor {
        focus(): void;
        aiInsertInCursor(text: string): void;
        readonly editorStore: EditorStoreApi;
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
     *  hidden — only what the app calls is typed. */
    export interface EditorStoreApi {
        resetMD(md: string): void;
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
        subscribe(listener: (newState: unknown, prevState: unknown) => void): () => void;
    }

    export interface DOMDProviderProps {
        children?: ReactNode;
        editable?: boolean;
        initMd?: string;
        placeholder?: string;
        imageLoader?: (src: string) => Promise<string>;
        codeTokenizer?: (code: string, lang?: string) => unknown[];
    }

    export const DOMD: React.FC;
    export const DOMDProvider: React.FC<DOMDProviderProps>;

    export function useEditor(): Editor | null;
    export function useEditorStoreApi(): EditorStoreApi | null;
    export function useRenderData(): RenderData;
    export function toMarkdown(data: RenderData): string | null;
}

declare module "@do-md/react/style.css";
