"use client";
/**
 * Resolves a document source and commits it to the window's TabStore.
 *
 * The API is unchanged from the single-document version — meta, content,
 * version, view plus one entry point per source — because everything that
 * consumes it (editor-app) should not care whether the window holds one
 * document or ten. What changed is where the result lands: the active tab
 * instead of local React state.
 *
 * That indirection is the whole point of the tabbed shell: tabs get the
 * upstream editor tree — collaboration, disk reconciliation, AI, the outline
 * panel — without a parallel copy of it.
 *
 * `content` is not returned, because there is no longer a content prop to
 * return. Each tab owns a live EditorStore and the provider is handed that
 * store directly, so the document never round-trips through React state.
 */
import { useCallback } from "react";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import { setCollabDocId } from "@/features/collaboration/lib/collab-db-tauri";
import { markKnownDiskContent } from "../lib/disk-sync";
import {
    buildFrontmatterBlock,
    ensureDomdId,
    splitFrontmatter,
} from "../lib/frontmatter";
import { fetchMarkdown, resolveMarkdownUrl } from "../lib/resolve-url";
import { useTabStore, useTabStoreApi } from "../stores/tab-store";
import type { FileMeta, View } from "../lib/types";

export function useDocumentLoaders() {
    const store = useTabStoreApi();
    const tabs = useTabStore((s) => s.state.tabs);
    const activeTabId = useTabStore((s) => s.state.activeTabId);
    const active = tabs.find((tab) => tab.id === activeTabId) ?? null;

    const meta = active?.meta ?? null;
    /** The active tab's live document runtime, handed to DOMDProvider as
     *  `store`. With it, every construction-time prop is ignored — the
     *  runtime already carries them. */
    const runtime = active ? (store.runtimeOf(active.id) ?? null) : null;
    /** Editor mount identity: the TAB, and nothing more.
     *
     *  The provider captures its store once on mount, so switching tabs has
     *  to remount the view. Replacing the DOCUMENT inside a tab must not —
     *  that resets the runtime in place, and remounting would discard the
     *  view state (selection, focus, scroll) the kernel just preserved. The
     *  old `${id}:${docEpoch}` key did exactly that, which is why the epoch
     *  is gone along with the serialize-and-remount model it belonged to. */
    const version = active?.id ?? "loading";
    const view: View = active && runtime ? "editor" : "loading";

    const setMeta = useCallback(
        (next: FileMeta) => {
            const id = store.state.activeTabId;
            if (id) store.updateTabMeta(id, next);
        },
        [store],
    );

    const applyBlank = useCallback(() => {
        if (isTauri()) {
            // A new document gets its identity at creation — collaboration
            // keys off this id in the global ~/.domd/collab.db, so sharing
            // works whether or not the file is ever saved. The frontmatter
            // block lives in meta and is written out on first save.
            const docId = crypto.randomUUID();
            setCollabDocId(docId);
            store.openInActiveTab(
                {
                    kind: "tauri",
                    path: null,
                    name: "Untitled.md",
                    docId,
                    frontmatter: buildFrontmatterBlock(docId),
                },
                "",
            );
            return;
        }
        store.openInActiveTab({ kind: "web", name: "Untitled.md", handle: null }, "");
    }, [store]);

    /** Blank web meta with restored local content (draft / collab doc).
     *  The name survives (draft mirrors named docs too) but the file handle
     *  cannot — restored drafts always re-save via the picker. */
    const applyLocal = useCallback(
        (localContent: string, name = "Untitled.md") => {
            store.openInActiveTab(
                { kind: "web", name, handle: null },
                localContent,
            );
        },
        [store],
    );

    const loadTauriPath = useCallback(
        async (path: string) => {
            const doc = await readTauriDoc(path);
            setCollabDocId(doc.meta.kind === "tauri" ? (doc.meta.docId ?? "") : "");
            store.openInActiveTab(doc.meta, doc.content);
        },
        [store],
    );

    // Drag-drop onto a Tauri window: claim the path in Rust's WindowFiles so
    // close-behavior and open_or_reuse stay consistent, then load it.
    const claimAndLoadTauriPath = useCallback(
        async (path: string) => {
            const { invoke } = await tauriCore();
            await invoke("set_window_path", { path });
            await loadTauriPath(path);
        },
        [loadTauriPath],
    );

    const loadRemote = useCallback(
        async (input: string) => {
            const doc = await readRemoteDoc(input);
            if (!doc) {
                applyBlank();
                return;
            }
            if (doc.meta.kind === "tauri" && doc.meta.docId) {
                setCollabDocId(doc.meta.docId);
            }
            store.openInActiveTab(doc.meta, doc.content);
        },
        [store, applyBlank],
    );

    const loadFromFile = useCallback(
        async (file: File, handle: FileSystemFileHandle | null) => {
            const fileContent = await file.text();
            store.openInActiveTab(
                { kind: "web", name: file.name, handle },
                fileContent,
            );
        },
        [store],
    );

    return {
        meta,
        setMeta,
        runtime,
        version,
        view,
        applyBlank,
        applyLocal,
        loadTauriPath,
        claimAndLoadTauriPath,
        loadRemote,
        loadFromFile,
    };
}

export interface LoadedDoc {
    meta: FileMeta;
    /** Body only — the frontmatter block lives in `meta.frontmatter` and is
     *  re-prepended by save-document. The editor never sees it. */
    content: string;
}

/**
 * Read a file from disk. Guarantees a frontmatter domd-id (writing the
 * injected block back), and registers the on-disk ground truth so the echo
 * guard and the no-op-write suppression both have a baseline.
 *
 * Exported because the tabbed shell loads documents into tabs that are NOT
 * the active one, where committing to React state would be wrong.
 */
export async function readTauriDoc(path: string): Promise<LoadedDoc> {
    const { invoke } = await tauriCore();
    const raw = await invoke<string>("read_file", { path }).catch(() => null);
    const name = path.split("/").pop() ?? path;
    if (raw === null) {
        // Unreadable file: open blank, without a doc identity. Do NOT write
        // anything back — the read failure may be transient.
        return { meta: { kind: "tauri", path, name, docId: null }, content: "" };
    }
    const ensured = ensureDomdId(raw);
    markKnownDiskContent(path, ensured.changed ? ensured.content : raw);
    if (ensured.changed) {
        await invoke("write_file", { path, content: ensured.content }).catch(
            () => {},
        );
    }
    const { prefix, body } = splitFrontmatter(ensured.content);
    return {
        meta: {
            kind: "tauri",
            path,
            name,
            docId: ensured.id,
            frontmatter: prefix,
        },
        content: body,
    };
}

/** Fetch a remote markdown document. Gets an in-memory identity on desktop
 *  (no disk write until saved) so it can be shared like any other. */
export async function readRemoteDoc(input: string): Promise<LoadedDoc | null> {
    const resolved = resolveMarkdownUrl(input);
    if (!resolved) return null;
    try {
        const fileContent = await fetchMarkdown(resolved.url, resolved.headers);
        if (!isTauri()) {
            return {
                meta: { kind: "web", name: resolved.filename, handle: null },
                content: fileContent,
            };
        }
        const ensured = ensureDomdId(fileContent);
        const { prefix, body } = splitFrontmatter(ensured.content);
        return {
            meta: {
                kind: "tauri",
                path: null,
                name: resolved.filename,
                docId: ensured.id,
                frontmatter: prefix,
            },
            content: body,
        };
    } catch {
        return null;
    }
}

/** A fresh untitled desktop document, for opening in a NEW tab. */
export function blankTauriDoc(): LoadedDoc {
    const docId = crypto.randomUUID();
    return {
        meta: {
            kind: "tauri",
            path: null,
            name: "Untitled.md",
            docId,
            frontmatter: buildFrontmatterBlock(docId),
        },
        content: "",
    };
}

/**
 * Re-read a backgrounded tab's file wholesale. Only ever called for tabs with
 * no unsaved edits: a dirty tab's divergence has to be merged, not
 * overwritten, which is the mounted DiskReconciler's job.
 */
export async function rereadTauriDoc(path: string): Promise<LoadedDoc | null> {
    const { invoke } = await tauriCore();
    const raw = await invoke<string>("read_file", { path }).catch(() => null);
    if (raw === null) return null;
    markKnownDiskContent(path, raw);
    const { prefix, body, id } = splitFrontmatter(raw);
    const name = path.split("/").pop() ?? path;
    return {
        meta: { kind: "tauri", path, name, docId: id, frontmatter: prefix },
        content: body,
    };
}
