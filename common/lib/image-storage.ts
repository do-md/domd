import Dexie, { type Table } from "dexie";
import { isTauri } from "./platform";
import { tauriCore } from "./tauri";

const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/tiff": "tiff",
};

function extOf(file: File | Blob, nameHint?: string): string {
    const name = (file instanceof File ? file.name : nameHint) || "";
    const dot = name.lastIndexOf(".");
    if (dot > 0 && dot < name.length - 1) {
        return name.slice(dot + 1).toLowerCase();
    }
    return MIME_TO_EXT[file.type] || "bin";
}

async function sha256Hex(blob: Blob): Promise<string> {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex.slice(0, 32);
}

// ── Web (IndexedDB via Dexie) ────────────────────────────────────────────────

interface ImageRecord {
    id: string;
    blob: Blob;
    mimeType: string;
    createdAt: number;
}

class DomdDb extends Dexie {
    images!: Table<ImageRecord, string>;
    constructor() {
        super("domd");
        this.version(1).stores({ images: "id, createdAt" });
    }
}

let _db: DomdDb | null = null;
function db(): DomdDb {
    if (!_db) _db = new DomdDb();
    return _db;
}

async function storeWeb(file: Blob, id: string): Promise<void> {
    const existing = await db().images.get(id);
    if (existing) return;
    await db().images.put({
        id,
        blob: file,
        mimeType: file.type,
        createdAt: Date.now(),
    });
}

export async function readWebImage(id: string): Promise<Blob | null> {
    const row = await db().images.get(id);
    return row?.blob ?? null;
}

// ── Desktop (Tauri filesystem) ───────────────────────────────────────────────

async function storeDesktop(file: Blob, name: string): Promise<string> {
    const { invoke } = await tauriCore();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return invoke<string>("save_image", { name, bytes });
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface StoredImage {
    url: string;
    altText: string;
}

export async function storeImage(file: File): Promise<StoredImage> {
    const ext = extOf(file);
    const hash = await sha256Hex(file);
    const name = `${hash}.${ext}`;
    const altText = file.name || `image.${ext}`;

    if (isTauri()) {
        const absPath = await storeDesktop(file, name);
        return { url: absPath, altText };
    }
    await storeWeb(file, hash);
    return { url: `domd-idb://${hash}`, altText };
}

// ── Loader (DOMDProvider imageLoader prop) ───────────────────────────────────

const isAbsoluteFsPath = (s: string) =>
    s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s);

const isUrlScheme = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s);

const isQuickLook = () =>
    typeof window !== "undefined" && window.location.protocol === "domd:";

function resolveRelative(dir: string, rel: string): string {
    const parts = dir.split("/").filter((p) => p.length > 0);
    for (const seg of rel.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return "/" + parts.join("/");
}

async function getMdBaseDir(): Promise<string | null> {
    if (isQuickLook()) {
        const dir = (window as Window & { __DOMD_PREVIEW_DIR__?: string })
            .__DOMD_PREVIEW_DIR__;
        return typeof dir === "string" ? dir : null;
    }
    if (isTauri()) {
        try {
            const { invoke } = await tauriCore();
            const path = await invoke<string | null>("get_my_path");
            if (!path) return null;
            const sep = Math.max(
                path.lastIndexOf("/"),
                path.lastIndexOf("\\"),
            );
            return sep > 0 ? path.slice(0, sep) : null;
        } catch {
            return null;
        }
    }
    return null;
}

const EXT_TO_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    heic: "image/heic",
    tiff: "image/tiff",
};

function mimeFromPath(p: string): string {
    const dot = p.lastIndexOf(".");
    if (dot < 0) return "application/octet-stream";
    return EXT_TO_MIME[p.slice(dot + 1).toLowerCase()] || "application/octet-stream";
}

export async function loadImage(src: string): Promise<string> {
    if (src.startsWith("domd-idb://")) {
        const id = src.slice("domd-idb://".length);
        const blob = await readWebImage(id);
        if (!blob) throw new Error(`image not found: ${src}`);
        return URL.createObjectURL(blob);
    }

    // Resolve to an absolute filesystem path when possible:
    //   - already absolute → use as-is
    //   - relative (no URL scheme) → resolve against the .md's directory
    //   - URL (http/https/data:) → leave alone
    let absPath: string | null = null;
    if (isAbsoluteFsPath(src)) {
        absPath = src;
    } else if (!isUrlScheme(src)) {
        const baseDir = await getMdBaseDir();
        if (baseDir) absPath = resolveRelative(baseDir, src);
    }

    if (absPath) {
        if (isTauri()) {
            const { invoke } = await tauriCore();
            const bytes = await invoke<number[]>("read_file_bytes", {
                path: absPath,
            });
            const blob = new Blob([new Uint8Array(bytes)], {
                type: mimeFromPath(absPath),
            });
            return URL.createObjectURL(blob);
        }
        if (isQuickLook()) {
            // Routed through PreviewURLSchemeHandler (Swift) which reads the
            // file via FileManager. Sandbox entitlements gate which paths
            // are actually readable.
            return `domd://file${encodeURI(absPath)}`;
        }
    }
    return src;
}

// ── Web export bundle (Save → write .md + .domd/assets/ alongside) ───────────

const IDB_REF_RE = /domd-idb:\/\/([a-f0-9]+)/g;

export function scanIdbRefs(md: string): Set<string> {
    const ids = new Set<string>();
    for (const m of md.matchAll(IDB_REF_RE)) ids.add(m[1]);
    return ids;
}

function extFromMime(mime: string): string {
    return MIME_TO_EXT[mime] || "bin";
}

/**
 * Write all referenced IDB images to `<rootDir>/.domd/assets/`. Skips files
 * already present (hash filename = dedup). Returns a map of id → relative
 * path (`.domd/assets/<id>.<ext>`) suitable for rewriting markdown.
 */
export async function bundleIdbImages(
    rootDir: FileSystemDirectoryHandle,
    ids: Iterable<string>,
): Promise<Map<string, string>> {
    const idArr = [...ids];
    if (idArr.length === 0) return new Map();

    const domdDir = await rootDir.getDirectoryHandle(".domd", { create: true });
    const assetsDir = await domdDir.getDirectoryHandle("assets", {
        create: true,
    });

    const mapping = new Map<string, string>();
    for (const id of idArr) {
        const row = await db().images.get(id);
        if (!row) continue;
        const ext = extFromMime(row.mimeType);
        const filename = `${id}.${ext}`;

        let exists = false;
        try {
            await assetsDir.getFileHandle(filename);
            exists = true;
        } catch {
            /* not present, will create */
        }
        if (!exists) {
            const fh = await assetsDir.getFileHandle(filename, {
                create: true,
            });
            const w = await fh.createWritable();
            await w.write(row.blob);
            await w.close();
        }
        mapping.set(id, `.domd/assets/${filename}`);
    }
    return mapping;
}

export function rewriteIdbRefs(
    md: string,
    mapping: Map<string, string>,
): string {
    return md.replace(IDB_REF_RE, (full, id) => mapping.get(id) ?? full);
}

export const IMAGE_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "avif",
    "heic",
    "tiff",
]);

export function isImagePath(p: string): boolean {
    const dot = p.lastIndexOf(".");
    if (dot < 0) return false;
    return IMAGE_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}
