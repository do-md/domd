"use client";
import { useCallback, useState } from "react";
import { fetchMarkdown, resolveMarkdownUrl } from "../lib/resolve-url";
import {
    buildFrontmatterBlock,
    ensureDomdId,
    splitFrontmatter,
} from "../lib/frontmatter";
import { setCollabDocId } from "@/features/collaboration/lib/collab-db-tauri";
import { markKnownDiskContent } from "../lib/disk-sync";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import type { FileMeta, View } from "../lib/types";

export function useDocumentLoaders() {
    const [meta, setMeta] = useState<FileMeta | null>(null);
    const [content, setContent] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const [view, setView] = useState<View>("loading");

    const applyBlank = useCallback(() => {
        if (isTauri()) {
            // A new document gets its identity at creation — collaboration
            // keys off this id in the global ~/.domd/collab.db, so sharing
            // works whether or not the file is ever saved. The frontmatter
            // block lives in meta and is written out on first save.
            const docId = crypto.randomUUID();
            setCollabDocId(docId);
            setMeta({
                kind: "tauri",
                path: null,
                name: "Untitled.md",
                docId,
                frontmatter: buildFrontmatterBlock(docId),
            });
        } else {
            setMeta({ kind: "web", name: "Untitled.md", handle: null });
        }
        setContent("");
        setVersion((n) => n + 1);
        setView("editor");
    }, []);

    /** Blank web meta with restored local content (draft / collab doc).
     *  The name survives (draft mirrors named docs too) but the file handle
     *  cannot — restored drafts always re-save via the picker. */
    const applyLocal = useCallback(
        (localContent: string, name = "Untitled.md") => {
            setMeta({ kind: "web", name, handle: null });
            setContent(localContent);
            setVersion((n) => n + 1);
            setView("editor");
        },
        [],
    );

    const loadTauriPath = useCallback(async (path: string) => {
        const { invoke } = await tauriCore();
        const raw = await invoke<string>("read_file", { path }).catch(
            () => null,
        );
        const name = path.split("/").pop() ?? path;
        if (raw === null) {
            // Unreadable file: open blank, without a doc identity. Do NOT
            // write anything back — the read failure may be transient.
            setMeta({ kind: "tauri", path, name, docId: null });
            setContent("");
            setVersion((n) => n + 1);
            setView("editor");
            return;
        }
        // Document identity: guarantee a frontmatter domd-id, silently
        // writing the injected block back to disk. The editor only ever sees
        // the body — the block is re-prepended on save (see save-document).
        const ensured = ensureDomdId(raw);
        // Register the on-disk ground truth either way — the echo guard and
        // the no-op-write suppression both key off it.
        markKnownDiskContent(path, ensured.changed ? ensured.content : raw);
        if (ensured.changed) {
            await invoke("write_file", {
                path,
                content: ensured.content,
            }).catch(() => {});
        }
        const { prefix, body } = splitFrontmatter(ensured.content);
        // Synchronous handoff (the editor-app effect re-applies it after the
        // commit; this closes the gap in between).
        setCollabDocId(ensured.id);
        setMeta({
            kind: "tauri",
            path,
            name,
            docId: ensured.id,
            frontmatter: prefix,
        });
        setContent(body);
        setVersion((n) => n + 1);
        setView("editor");
    }, []);

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
            const resolved = resolveMarkdownUrl(input);
            if (!resolved) {
                applyBlank();
                return;
            }
            try {
                const fileContent = await fetchMarkdown(
                    resolved.url,
                    resolved.headers,
                );
                if (isTauri()) {
                    // Remote docs get an identity too (kept in-memory, no
                    // disk write until the user saves) so they can host a
                    // collaboration session like any other document.
                    const ensured = ensureDomdId(fileContent);
                    const { prefix, body } = splitFrontmatter(ensured.content);
                    setCollabDocId(ensured.id);
                    setMeta({
                        kind: "tauri",
                        path: null,
                        name: resolved.filename,
                        docId: ensured.id,
                        frontmatter: prefix,
                    });
                    setContent(body);
                    setVersion((n) => n + 1);
                    setView("editor");
                    return;
                }
                setMeta({
                    kind: "web",
                    name: resolved.filename,
                    handle: null,
                });
                setContent(fileContent);
                setVersion((n) => n + 1);
                setView("editor");
            } catch {
                applyBlank();
            }
        },
        [applyBlank],
    );

    const loadFromFile = useCallback(
        async (file: File, handle: FileSystemFileHandle | null) => {
            const fileContent = await file.text();
            setMeta({ kind: "web", name: file.name, handle });
            setContent(fileContent);
            // setContent("");
            // setTimeout(() => {
            //     window.mockAI(fileContent);
            // }, 200);
            setVersion((n) => n + 1);
            setView("editor");
        },
        [],
    );

    return {
        meta,
        setMeta,
        content,
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
