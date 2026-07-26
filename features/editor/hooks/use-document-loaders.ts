"use client";
import { useCallback, useState } from "react";
import { fetchMarkdown, resolveMarkdownUrl } from "../lib/resolve-url";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import type { FileMeta, View } from "../lib/types";

export function useDocumentLoaders() {
    const [meta, setMeta] = useState<FileMeta | null>(null);
    const [content, setContent] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const [view, setView] = useState<View>("loading");

    const applyBlank = useCallback(() => {
        setMeta(
            isTauri()
                ? { kind: "tauri", path: null, name: "Untitled.md" }
                : { kind: "web", name: "Untitled.md", handle: null },
        );
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
        const fileContent = await invoke<string>("read_file", { path }).catch(
            () => "",
        );
        const name = path.split("/").pop() ?? path;
        setMeta({ kind: "tauri", path, name });
        setContent(fileContent);
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
                    setMeta({
                        kind: "tauri",
                        path: null,
                        name: resolved.filename,
                    });
                } else {
                    setMeta({
                        kind: "web",
                        name: resolved.filename,
                        handle: null,
                    });
                }
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
