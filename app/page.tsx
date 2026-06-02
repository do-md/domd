import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { ReadmeEditor, TauriRedirect } from "@/features/landing";

export const metadata: Metadata = {
    title: "DOMD — A clean WYSIWYG Markdown editor",
    description:
        "DOMD is a WYSIWYG editor built on a from-scratch, Markdown-native rendering engine. 20 KB gzipped kernel — no account, no cloud, files stay on your device.",
};

// Strip raw HTML (tags, comments) from the README so the editor never sees
// any embedded markup — keeps the rendered surface pure Markdown.
function stripHtml(md: string): string {
    return md
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\/?[a-zA-Z][^>]*>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function loadReadme(file: string): Promise<string> {
    const md = await fs.readFile(path.join(process.cwd(), file), "utf-8");
    return stripHtml(md);
}

async function loadReadmes() {
    const [en, zh, ja] = await Promise.all([
        loadReadme("README.md"),
        loadReadme("README.zh-CN.md"),
        loadReadme("README.ja.md"),
    ]);
    return { en, zh, ja };
}

export default async function Landing() {
    const readmes = await loadReadmes();

    return (
        <div className="min-h-screen flex flex-col bg-base-100 text-base-content">
            <TauriRedirect />
            <header className="sticky top-0 z-20 bg-base-100/90 backdrop-blur border-b border-base-300">
                <nav className="max-w-3xl mx-auto flex items-center justify-between px-6 h-14">
                    <a
                        href="https://github.com/do-md/domd"
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label="GitHub"
                        className="btn btn-ghost btn-sm btn-circle"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            className="w-5 h-5"
                        >
                            <path
                                fillRule="evenodd"
                                clipRule="evenodd"
                                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.683-.217.683-.483 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
                            />
                        </svg>
                    </a>
                    <Link
                        href="/editor"
                        className="btn btn-link btn-sm no-underline hover:underline"
                        style={{ color: "rgb(60, 124, 171)" }}
                    >
                        Try Online
                    </Link>
                </nav>
            </header>

            <main className="flex-1">
                <section className="max-w-3xl mx-auto px-6 py-4">
                    <ReadmeEditor streams={readmes} />
                </section>
            </main>

            <footer className="border-t border-base-300 py-8">
                <div className="max-w-3xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-base-content/50">
                    <span>© {new Date().getFullYear()} DOMD</span>
                    <span>A clean place to write Markdown.</span>
                </div>
            </footer>
        </div>
    );
}
