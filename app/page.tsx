import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import {
    LandingFooter,
    LandingHeader,
    ReadmeEditor,
    TauriRedirect,
} from "@/features/landing";

const TITLE = "DOMD — A clean WYSIWYG Markdown editor";
const DESCRIPTION =
    "DOMD is a WYSIWYG editor built on a from-scratch, Markdown-native rendering engine. 20 KB gzipped kernel — no account, no cloud, files stay on your device.";

export const metadata: Metadata = {
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: {
        canonical: "/",
    },
    keywords: [
        "WYSIWYG Markdown editor",
        "Markdown editor",
        "Markdown native engine",
        "AI streaming Markdown editor",
        "large Markdown file editor",
        "macOS Markdown app",
        "local-first Markdown editor",
        "Typora alternative",
    ],
    openGraph: {
        type: "website",
        siteName: "DOMD",
        locale: "en_US",
        url: "/",
        title: TITLE,
        description: DESCRIPTION,
    },
    twitter: {
        card: "summary_large_image",
        title: TITLE,
        description: DESCRIPTION,
    },
};

// Structured data for rich results: DOMD is a free, cross-platform editor app.
const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "DOMD",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Markdown editor",
    operatingSystem: "macOS, Web",
    description: DESCRIPTION,
    url: "https://www.domd.app",
    downloadUrl: "https://github.com/do-md/domd/releases/latest",
    softwareHelp: "https://github.com/do-md/domd",
    offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
    },
    featureList: [
        "WYSIWYG editing directly on Markdown",
        "20 KB from-scratch Markdown-native engine",
        "Real-time AI Markdown streaming",
        "Smooth editing through 20,000-line documents",
        "Native macOS app with Quick Look preview",
        "Local-first — no account, no cloud",
    ],
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
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
            />
            <TauriRedirect />
            <LandingHeader />

            <main className="flex-1">
                <section className="max-w-3xl mx-auto px-6 py-4">
                    <ReadmeEditor streams={readmes} />
                </section>
            </main>

            <LandingFooter year={new Date().getFullYear()} />
        </div>
    );
}
