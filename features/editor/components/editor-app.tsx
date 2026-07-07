"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DOMDProvider } from "@do-md/core-react";
import { useTranslation } from "react-i18next";
import { track } from "@vercel/analytics";
import { tokenize } from "@/common/lib/prism";
import { loadImage } from "@/common/lib/image-storage";
import { isTauri } from "@/common/lib/platform";
import { tauriApp, tauriCore } from "@/common/lib/tauri";
import { ImageDropHandler } from "../hooks/use-image-drop";
import { useDocumentLoaders } from "../hooks/use-document-loaders";
import { useTauriDragDrop } from "../hooks/use-tauri-drag-drop";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { useWebDragDrop } from "../hooks/use-web-drag-drop";
import { UpdateBanner } from "@/features/updater/update-banner";
import { Editor } from "./editor";
import { UrlModal } from "./url-modal";

export function EditorApp() {
    const { t } = useTranslation();
    const searchParams = useSearchParams();

    // Initial state is always null/null so SSR (`output: "export"`) and the
    // first client render produce the same neutral placeholder — no hydration
    // mismatch. The mount effect below resolves the real source.
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
    } = useDocumentLoaders();

    const [showUrlModal, setShowUrlModal] = useState(false);

    const metaRef = useRef(meta);
    metaRef.current = meta;
    const saveRef = useRef<(() => Promise<boolean>) | null>(null);

    // Tauri-only: emit a custom analytics event on each webview mount so the
    // dashboard can distinguish desktop sessions from web pageviews. Version
    // is read via the Tauri API (canonical app version) rather than the FE
    // package.json. Failures are swallowed — analytics must not break the app.
    useEffect(() => {
        if (!isTauri()) return;
        (async () => {
            try {
                const { getVersion } = await tauriApp();
                const version = await getVersion();
                track("app_open", { platform: "tauri", version });
            } catch {
                track("app_open", { platform: "tauri" });
            }
        })();
    }, []);

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
                        {t("editor.releaseToOpen")}
                    </div>
                </div>
            ) : null}

            <DOMDProvider
                key={version}
                editable={true}
                placeholder={t("editor.placeholder")}
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
                />
            </DOMDProvider>

            {showUrlModal ? (
                <UrlModal
                    onClose={() => setShowUrlModal(false)}
                    onSubmit={loadRemote}
                />
            ) : null}

            <UpdateBanner />
        </div>
    );
}
