/**
 * Canonicalize arbitrary markdown through the kernel (parse -> serialize).
 *
 * The editor's serialization is canonical (tables re-padded, list markers
 * normalized, LF endings), so diffing an external file against the live
 * document must first normalize the external text the same way — otherwise
 * pure formatting differences show up as phantom edits and the reconcile
 * equality check would never settle.
 *
 * Since @do-md/core-react 0.8.2 the EditorStore class is a typed public
 * export and officially headless-constructible (`new EditorStore({...})` —
 * see the package README's "Headless usage"), so this scratch-provider
 * indirection could be retired in favor of a direct module-level store.
 * Kept as-is for now: the hidden scratch DOMDProvider (store only — no
 * <DOMD/> surface, hence no editor DOM) is configured with the SAME parsing
 * options as the live editor and registers its store here (see
 * ScratchCanonicalizer in editor-app). Multiple providers coexisting is
 * proven ground — /playground/live runs two side by side.
 */
import type { useEditorStoreApi } from "@do-md/core-react";

type StoreApi = NonNullable<ReturnType<typeof useEditorStoreApi>>;

let scratch: StoreApi | null = null;

/** Registered by the hidden scratch provider on mount (null on unmount). */
export const setScratchStore = (store: StoreApi | null): void => {
    scratch = store;
};

/** Parse -> serialize `md` through the kernel. Returns null while the
 *  scratch store has not mounted yet (callers should retry later — the
 *  next watcher event will). */
export const canonicalizeMd = (md: string): string | null => {
    if (!scratch) return null;
    scratch.resetMD(md.replace(/\r\n?/g, "\n"));
    return scratch.toMarkdown() ?? "";
};
