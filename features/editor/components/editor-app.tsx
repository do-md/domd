"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DOMDProvider } from "@do-md/react";
import { tokenize } from "@/common/lib/prism";
import { loadImage } from "@/common/lib/image-storage";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import {
    fetchLocalFiles,
    saveLocalFile,
    type LocalFileEntry,
} from "../lib/local-files";
import { ImageDropHandler } from "../hooks/use-image-drop";
import { useDocumentLoaders } from "../hooks/use-document-loaders";
import { useTauriDragDrop } from "../hooks/use-tauri-drag-drop";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { useWebDragDrop } from "../hooks/use-web-drag-drop";
import { Editor } from "./editor";
import { UrlModal } from "./url-modal";

export function EditorApp() {
    const searchParams = useSearchParams();

    // Initial state is always null/null so SSR and the first client render
    // produce the same neutral placeholder — no hydration mismatch. The mount
    // effect below resolves the real source.
    const {
        meta,
        setMeta,
        content,
        version,
        view,
        applyBlank,
        loadTauriPath,
        claimAndLoadTauriPath,
        loadRemote,
        loadFromFile,
        loadLocalPath,
    } = useDocumentLoaders();

    const [showUrlModal, setShowUrlModal] = useState(false);
    const [localFiles, setLocalFiles] = useState<LocalFileEntry[]>([]);
    const [localRoot, setLocalRoot] = useState<string | null>(null);
    const [localFilesLoading, setLocalFilesLoading] = useState(false);
    const [localFilesError, setLocalFilesError] = useState<string | null>(null);
    const [localOpenError, setLocalOpenError] = useState<string | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const metaRef = useRef(meta);
    metaRef.current = meta;
    const saveRef = useRef<(() => Promise<boolean>) | null>(null);

    // Resolve the initial source on mount. Each branch ends by setting
    // meta/content (directly or via applyBlank), which flips view to "editor".
    useEffect(() => {
        const src = searchParams.get("src");
        const pathParam = searchParams.get("path");

        (async () => {
            if (src) {
                await loadRemote(src);
                return;
            }
            if (pathParam && isTauri()) {
                await loadTauriPath(pathParam);
                return;
            }
            if (isTauri()) {
                const { invoke } = await tauriCore();
                const assigned = await invoke<string | null>("get_my_path");
                if (assigned) {
                    await loadTauriPath(assigned);
                    return;
                }
                applyBlank();
                return;
            }
            applyBlank();
        })();
        // Run once. URL param changes come via full-remount navigation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Tauri: listen for open-file events (fired when Rust reuses this window
    // for a file double-clicked elsewhere).
    useTauriEvent<string>("open-file", (path) => {
        loadTauriPath(path);
    });

    // Tauri: menu → "Open URL..." opens the same modal as the web button.
    useTauriEvent("menu-open-url", () => setShowUrlModal(true));

    const tauriDragging = useTauriDragDrop(claimAndLoadTauriPath);
    const { dragging: webDragging, dragHandlers } = useWebDragDrop(
        ({ file, handle }) => {
            loadFromFile(file, handle);
        },
    );

    const isWeb = !isTauri();
    const dragging = tauriDragging || webDragging;

    const refreshLocalFiles = useCallback(async () => {
        if (!isWeb) return;
        setLocalFilesLoading(true);
        try {
            const result = await fetchLocalFiles();
            setLocalFiles(result.files);
            setLocalRoot(result.root);
            setLocalFilesError(null);
        } catch (error) {
            setLocalFiles([]);
            setLocalRoot(null);
            setLocalFilesError(
                error instanceof Error
                    ? error.message
                    : "Failed to load local files.",
            );
        } finally {
            setLocalFilesLoading(false);
        }
    }, [isWeb]);

    const normalizeLocalPath = useCallback((raw: string) => {
        const trimmed = raw.trim().replace(/\\/g, "/");
        const withoutLeading = trimmed.replace(/^\/+/, "");
        if (!withoutLeading) return null;
        if (/^[a-zA-Z]:/.test(withoutLeading)) return null;
        const parts = withoutLeading.split("/");
        if (parts.some((part) => !part || part === "." || part === "..")) {
            return null;
        }
        const withExt = /\.(md|markdown)$/i.test(withoutLeading)
            ? withoutLeading
            : `${withoutLeading}.md`;
        return withExt;
    }, []);

    useEffect(() => {
        if (!isWeb) return;
        refreshLocalFiles();
        if (window.matchMedia("(min-width: 768px)").matches) {
            setSidebarOpen(true);
        }
    }, [isWeb, refreshLocalFiles]);

    const handleOpenLocalFile = useCallback(
        async (path: string) => {
            try {
                await loadLocalPath(path);
                setLocalOpenError(null);
                if (window.matchMedia("(max-width: 767px)").matches) {
                    setSidebarOpen(false);
                }
            } catch (error) {
                setLocalOpenError(
                    error instanceof Error
                        ? error.message
                        : "Failed to open file.",
                );
            }
        },
        [loadLocalPath],
    );

    const handleCreateLocalFile = useCallback(async () => {
        if (!isWeb) return;
        const input = window.prompt(
            "New file name (relative to the local folder):",
            "Untitled.md",
        );
        if (input === null) return;
        const normalized = normalizeLocalPath(input);
        if (!normalized) {
            setLocalOpenError("Please enter a valid relative markdown path.");
            return;
        }
        const exists = localFiles.some(
            (file) => file.path.toLowerCase() === normalized.toLowerCase(),
        );
        if (exists) {
            const overwrite = window.confirm(
                "A file with this name already exists. Overwrite it?",
            );
            if (!overwrite) return;
        }
        try {
            await saveLocalFile(normalized, "");
            await refreshLocalFiles();
            await handleOpenLocalFile(normalized);
            setLocalOpenError(null);
        } catch (error) {
            setLocalOpenError(
                error instanceof Error
                    ? error.message
                    : "Failed to create file.",
            );
        }
    }, [
        isWeb,
        localFiles,
        normalizeLocalPath,
        refreshLocalFiles,
        handleOpenLocalFile,
    ]);

    if (view === "loading") {
        return <div className="fixed inset-0 bg-base-100" />;
    }

    if (meta === null || content === null) {
        return <div className="fixed inset-0 bg-base-100" />;
    }

    return (
        <div
            onDragOver={isWeb ? dragHandlers.onDragOver : undefined}
            onDragLeave={isWeb ? dragHandlers.onDragLeave : undefined}
            onDrop={isWeb ? dragHandlers.onDrop : undefined}
        >
            {dragging ? (
                <div className="fixed inset-0 z-20 flex items-center justify-center bg-accent/90 pointer-events-none">
                    <div className="text-lg font-medium text-accent-content">
                        Release to open
                    </div>
                </div>
            ) : null}

            <DOMDProvider
                key={version}
                editable={true}
                placeholder="Start writing Markdown..."
                initMd={content}
                imageLoader={loadImage}
                codeTokenizer={tokenize}
            >
                <ImageDropHandler />
                <Editor
                    meta={meta}
                    onMetaUpdate={setMeta}
                    onRequestOpenUrl={() => setShowUrlModal(true)}
                    saveRef={saveRef}
                    localFiles={localFiles}
                    localFilesLoading={localFilesLoading}
                    localFilesError={localFilesError}
                    localOpenError={localOpenError}
                    localRoot={localRoot}
                    sidebarOpen={sidebarOpen}
                    onToggleSidebar={() =>
                        setSidebarOpen((current) => !current)
                    }
                    onReloadLocalFiles={refreshLocalFiles}
                    onOpenLocalFile={handleOpenLocalFile}
                    onCreateLocalFile={handleCreateLocalFile}
                    showLocalFiles={isWeb}
                />
            </DOMDProvider>

            {showUrlModal ? (
                <UrlModal
                    onClose={() => setShowUrlModal(false)}
                    onSubmit={loadRemote}
                />
            ) : null}
        </div>
    );
}
