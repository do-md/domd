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
    /** Editor mount identity: the tab AND the document generation it holds.
     *
     *  The provider captures its store once on mount, so anything that puts
     *  a different runtime under the view has to remount it. That is two
     *  events: switching tabs (id changes) and replacing the document inside
     *  a tab (docEpoch changes — replaceTabDoc builds a fresh runtime, see
     *  tab-store for why in-place reset is not an option). A switch remounts
     *  over the OTHER tab's long-lived runtime — an attach, not a re-parse —
     *  so the expensive path is still only paid when a new document loads,
     *  exactly as the pre-tabs shell did. */
    const version = active ? `${active.id}:${active.docEpoch}` : "loading";
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
    const doc = await readDiskDoc(path);
    if (doc) return doc;
    // Unreadable file: open blank, without a doc identity. Do NOT write
    // anything back — the read failure may be transient.
    const name = path.split("/").pop() ?? path;
    return { meta: { kind: "tauri", path, name, docId: null }, content: "" };
}

/** The shared core of readTauriDoc / rereadTauriDoc: read, guarantee a
 *  domd-id (self-healing a file whose frontmatter an external tool dropped —
 *  the identity keys collaboration data in ~/.domd/collab.db, so adopting
 *  `docId: null` from a re-read would strand the document's rooms), register
 *  the disk ground truth, split. Null when the file cannot be read. */
async function readDiskDoc(path: string): Promise<LoadedDoc | null> {
    const { invoke } = await tauriCore();
    const raw = await invoke<string>("read_file", { path }).catch(() => null);
    if (raw === null) return null;
    const ensured = ensureDomdId(raw);
    markKnownDiskContent(path, ensured.changed ? ensured.content : raw);
    if (ensured.changed) {
        await invoke("write_file", { path, content: ensured.content }).catch(
            () => {},
        );
    }
    const { prefix, body } = splitFrontmatter(ensured.content);
    const name = path.split("/").pop() ?? path;
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
 *
 * Same pipeline as the first read — in particular the domd-id guarantee. An
 * external rewrite that dropped the frontmatter (formatter, git checkout,
 * sync-conflict copy) must not strip the document's identity on re-read.
 */
export async function rereadTauriDoc(path: string): Promise<LoadedDoc | null> {
    return readDiskDoc(path);
}
