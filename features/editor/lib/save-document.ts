import {
    bundleIdbImages,
    rewriteIdbRefs,
    scanIdbRefs,
} from "@/common/lib/image-storage";
import { tauriCore, tauriDialog } from "@/common/lib/tauri";
import i18n from "@/common/i18n";
import type { FileMeta } from "./types";

export type SaveResult =
    | { ok: true; meta: FileMeta }
    | { ok: false };

export async function saveDocument(
    currentMeta: FileMeta,
    md: string,
    getTitle?: () => Promise<string> | string,
): Promise<SaveResult> {
    try {
        if (currentMeta.kind === "tauri") {
            return await saveTauri(currentMeta, md, getTitle);
        }
        return await saveWeb(currentMeta, md, getTitle);
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            return { ok: false };
        }
        console.error(e);
        return { ok: false };
    }
}

async function saveTauri(
    currentMeta: Extract<FileMeta, { kind: "tauri" }>,
    md: string,
    getTitle?: () => Promise<string> | string,
): Promise<SaveResult> {
    const { invoke } = await tauriCore();
    if (currentMeta.path) {
        await invoke("write_file", { path: currentMeta.path, content: md });
        return { ok: true, meta: currentMeta };
    }
    const suggested = await resolveSuggestedName(invoke, getTitle);
    const { save } = await tauriDialog();
    const selectedPath = await save({
        defaultPath: suggested,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!selectedPath) return { ok: false };
    await invoke("write_file", { path: selectedPath, content: md });
    await invoke("set_window_path", { path: selectedPath });
    const name = selectedPath.split("/").pop() ?? selectedPath;
    return { ok: true, meta: { kind: "tauri", path: selectedPath, name } };
}

async function resolveSuggestedName(
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
    getTitle?: () => Promise<string> | string,
): Promise<string> {
    if (!getTitle) return "Untitled.md";
    try {
        const raw = await getTitle();
        return (await invoke("sanitize_filename", {
            title: raw ?? "",
        })) as string;
    } catch {
        return "Untitled.md";
    }
}

async function sanitizeWebName(
    getTitle: (() => Promise<string> | string) | undefined,
    fallback: string,
): Promise<string> {
    if (!getTitle) return fallback;
    try {
        const raw = (await getTitle()) ?? "";
        const cleaned = raw
            .replace(/[\\/:*?"<>|\0\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^\.+|[.\s]+$/g, "");
        const truncated = Array.from(cleaned).slice(0, 80).join("");
        const stem = truncated || "Untitled";
        return /\.(md|markdown)$/i.test(stem) ? stem : `${stem}.md`;
    } catch {
        return fallback;
    }
}

async function saveWeb(
    currentMeta: Extract<FileMeta, { kind: "web" }>,
    md: string,
    getTitle?: () => Promise<string> | string,
): Promise<SaveResult> {
    const idbIds = scanIdbRefs(md);
    let dirHandle = currentMeta.dirHandle ?? null;
    let fileHandle = currentMeta.handle ?? null;

    // Step 1: if doc has images and no asset dir yet, ask for a folder.
    // Tell the user this picker is for images.
    if (idbIds.size > 0 && !dirHandle && "showDirectoryPicker" in window) {
        window.alert(i18n.t("editor.saveDialog.imagesFolderPrompt"));
        dirHandle = await (
            window as unknown as {
                showDirectoryPicker(opts?: {
                    mode?: "read" | "readwrite";
                }): Promise<FileSystemDirectoryHandle>;
            }
        ).showDirectoryPicker({ mode: "readwrite" });
    }

    // Step 2: ensure we have a file handle for the .md.
    if (!fileHandle) {
        const suggested = await sanitizeWebName(getTitle, currentMeta.name);
        if (!("showSaveFilePicker" in window)) {
            const blob = new Blob([md], { type: "text/markdown" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = suggested;
            a.click();
            URL.revokeObjectURL(a.href);
            return { ok: true, meta: currentMeta };
        }
        const buildOpts = (): {
            suggestedName: string;
            types: unknown;
            startIn?: FileSystemDirectoryHandle;
        } => {
            const o: {
                suggestedName: string;
                types: unknown;
                startIn?: FileSystemDirectoryHandle;
            } = {
                suggestedName: suggested,
                types: [
                    {
                        description: "Markdown",
                        accept: {
                            "text/markdown": [".md", ".markdown"],
                        },
                    },
                ],
            };
            if (dirHandle) o.startIn = dirHandle;
            return o;
        };
        const showSaveFilePicker = (
            window as unknown as {
                showSaveFilePicker(
                    opts: unknown,
                ): Promise<FileSystemFileHandle>;
            }
        ).showSaveFilePicker;

        // If we have an asset dir, the .md must be saved inside it (or a
        // sub-folder) so the relative path from .md to .domd/assets/ is
        // computable. Loop until the user picks a valid location or cancels.
        while (true) {
            fileHandle = await showSaveFilePicker(buildOpts());
            if (!dirHandle) break;
            const components = await dirHandle.resolve(fileHandle);
            if (components) break;
            const retry = window.confirm(
                i18n.t("editor.saveDialog.mustSaveInFolder", {
                    folder: dirHandle.name,
                }),
            );
            if (!retry) return { ok: false };
            fileHandle = null;
        }
    }

    // Step 3: bundle (if any), compute relative paths, write.
    const mapping = new Map<string, string>();
    if (dirHandle && idbIds.size > 0) {
        const raw = await bundleIdbImages(dirHandle, idbIds);
        const components = await dirHandle.resolve(fileHandle);
        const prefix =
            components && components.length > 1
                ? "../".repeat(components.length - 1)
                : "";
        for (const [id, rel] of raw) {
            mapping.set(id, `${prefix}${rel}`);
        }
    }
    const finalMd = rewriteIdbRefs(md, mapping);

    const writable = await fileHandle.createWritable();
    await writable.write(finalMd);
    await writable.close();

    return {
        ok: true,
        meta: {
            kind: "web",
            name: fileHandle.name,
            handle: fileHandle,
            dirHandle,
        },
    };
}
