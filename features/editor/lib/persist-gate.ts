/**
 * The persistence choke point.
 *
 * A document that is still streaming into the model (the kernel's chunked
 * load) is a PREFIX of the file, not the file — persisting it truncates the
 * user's data (the task-54474e P0) and re-parsing it makes that truncation
 * permanent. The first fix scattered `if (docLoading) return` guards across
 * the consumers; a review found five more consumers that never got one, which
 * is the failure mode of per-call-site guards: the rule lives in the callers'
 * heads instead of in the code.
 *
 * So the rule lives here instead. Nothing in the app may turn a document into
 * bytes for persistence or export except through `serializeForPersist`, which
 * simply refuses while the document is incomplete. DOM-based exports (print /
 * PDF), which have no markdown to gate, ask `isPersistBlocked` for the same
 * verdict.
 *
 * Structural typing, not a kernel import: headless tests and older kernels
 * (no loading signal at all) both satisfy it, and a kernel without the signal
 * degrades to "never blocked", which is the pre-chunking behavior.
 */
import { toMarkdown } from "@do-md/core-react";
import type { AnyRenderData } from "@do-md/core-react";

export interface PersistableStore {
    /** Kernel >= the render-window release; absent on older kernels. */
    isLoadingChunks?: boolean;
    toMarkdown?: () => string;
}

/** True while the document must not be persisted, exported or re-parsed as a
 *  whole. Null/undefined stores are blocked: no store, no document. */
export const isPersistBlocked = (
    store: PersistableStore | null | undefined,
): boolean => {
    if (!store) return true;
    return store.isLoadingChunks === true;
};

/**
 * The document's markdown, or `null` when it must not leave the editor yet.
 *
 * `data` lets render-driven callers serialize the exact tree they hold (the
 * autosave debounce carries the renderData its timer was armed with); without
 * it the store's own current tree is used.
 */
export const serializeForPersist = (
    store: PersistableStore | null | undefined,
    data?: AnyRenderData | null,
): string | null => {
    if (isPersistBlocked(store)) return null;
    if (data) return toMarkdown(data) ?? "";
    return store?.toMarkdown?.() ?? null;
};
