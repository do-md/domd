import { NextResponse } from "next/server";
import path from "path";
import { readdir, readFile, stat, writeFile } from "fs/promises";
import { LOCAL_MARKDOWN_DIR } from "@/config/server";

export const dynamic = "force-dynamic";

const allowedExtensions = new Set([".md", ".markdown"]);
const baseDir = path.resolve(LOCAL_MARKDOWN_DIR);

type LocalFileEntry = {
    path: string;
    name: string;
    size: number;
    updatedAt: number;
};

function isAllowed(filePath: string) {
    return allowedExtensions.has(path.extname(filePath).toLowerCase());
}

function toRelative(filePath: string) {
    return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function resolveWithinBase(relativePath: string) {
    const trimmed = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
    const resolved = path.resolve(baseDir, trimmed);
    if (resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`)) {
        return resolved;
    }
    throw new Error("Invalid path");
}

async function listMarkdownFiles(dir: string): Promise<LocalFileEntry[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: LocalFileEntry[] = [];
    for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listMarkdownFiles(absolute)));
            continue;
        }
        if (!entry.isFile() || !isAllowed(absolute)) continue;
        const fileStat = await stat(absolute);
        files.push({
            path: toRelative(absolute),
            name: entry.name,
            size: fileStat.size,
            updatedAt: fileStat.mtimeMs,
        });
    }
    return files;
}

async function loadFileContent(relativePath: string) {
    const resolved = resolveWithinBase(relativePath);
    if (!isAllowed(resolved)) {
        return {
            ok: false,
            status: 400,
            message: "Only markdown files are supported.",
        };
    }
    try {
        const content = await readFile(resolved, "utf8");
        return {
            ok: true,
            content,
            name: path.basename(resolved),
            path: relativePath,
        } as const;
    } catch {
        return { ok: false, status: 404, message: "File not found." };
    }
}

async function saveFileContent(relativePath: string, content: string) {
    const resolved = resolveWithinBase(relativePath);
    if (!isAllowed(resolved)) {
        return {
            ok: false,
            status: 400,
            message: "Only markdown files are supported.",
        };
    }
    await writeFile(resolved, content, "utf8");
    return { ok: true } as const;
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const pathParam = searchParams.get("path");
    if (pathParam) {
        const file = await loadFileContent(pathParam);
        if (!file.ok) {
            return NextResponse.json(
                { error: file.message },
                { status: file.status },
            );
        }
        return NextResponse.json({
            path: file.path,
            name: file.name,
            content: file.content,
        });
    }
    try {
        const rootStat = await stat(baseDir);
        if (!rootStat.isDirectory()) {
            return NextResponse.json(
                { error: "Configured path is not a directory." },
                { status: 500 },
            );
        }
        const files = await listMarkdownFiles(baseDir);
        files.sort((a, b) => a.path.localeCompare(b.path));
        return NextResponse.json({ root: baseDir, files });
    } catch {
        return NextResponse.json(
            { error: "Unable to read the local markdown folder." },
            { status: 500 },
        );
    }
}

export async function PUT(request: Request) {
    const { searchParams } = new URL(request.url);
    const pathParam = searchParams.get("path");
    if (!pathParam) {
        return NextResponse.json(
            { error: "Missing path." },
            { status: 400 },
        );
    }
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { error: "Invalid JSON body." },
            { status: 400 },
        );
    }
    if (
        !body ||
        typeof body !== "object" ||
        !("content" in body) ||
        typeof body.content !== "string"
    ) {
        return NextResponse.json(
            { error: "Missing content." },
            { status: 400 },
        );
    }
    try {
        const result = await saveFileContent(pathParam, body.content);
        if (!result.ok) {
            return NextResponse.json(
                { error: result.message },
                { status: result.status },
            );
        }
        return NextResponse.json({ ok: true });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Unable to save file.";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
