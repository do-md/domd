export type LocalFileEntry = {
    path: string;
    name: string;
    size: number;
    updatedAt: number;
};

export type LocalFileList = {
    root: string;
    files: LocalFileEntry[];
};

export async function fetchLocalFiles(): Promise<LocalFileList> {
    const res = await fetch("/api/local-files", { cache: "no-store" });
    if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
        throw new Error(payload?.error ?? "Failed to load local files.");
    }
    return (await res.json()) as LocalFileList;
}

export async function fetchLocalFile(path: string): Promise<{
    path: string;
    name: string;
    content: string;
}> {
    const res = await fetch(`/api/local-files?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
        throw new Error(payload?.error ?? "Failed to load file.");
    }
    return (await res.json()) as {
        path: string;
        name: string;
        content: string;
    };
}

export async function saveLocalFile(path: string, content: string) {
    const res = await fetch(`/api/local-files?path=${encodeURIComponent(path)}`,
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
        },
    );
    if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
        throw new Error(payload?.error ?? "Failed to save file.");
    }
}
