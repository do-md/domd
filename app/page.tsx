import Link from "next/link";
import { TauriRedirect } from "@/features/landing";

// Mock download link until real builds are published.
const MAC_DOWNLOAD_URL = "#download";

export default function Landing() {
    return (
        <div className="min-h-screen flex flex-col bg-base-100 text-base-content">
            <TauriRedirect />
            <header className="sticky top-0 z-20 bg-base-100/90 backdrop-blur border-b border-base-300">
                <nav className="max-w-5xl mx-auto flex items-center justify-between px-6 h-14">
                    <Link
                        href="/"
                        className="text-lg font-bold tracking-wide"
                    >
                        DOMD
                    </Link>
                    <div className="flex items-center gap-6 text-sm">
                        <a
                            href="#features"
                            className="hover:text-primary transition-colors"
                        >
                            Features
                        </a>
                        <a
                            href="#online"
                            className="hover:text-primary transition-colors"
                        >
                            Online
                        </a>
                        <a
                            href="#download"
                            className="hover:text-primary transition-colors"
                        >
                            Download
                        </a>
                    </div>
                </nav>
            </header>

            <main className="flex-1">
                {/* Hero */}
                <section className="max-w-5xl mx-auto px-6 py-24 text-center">
                    <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6">
                        A clean Markdown editor.
                    </h1>
                    <p className="text-lg md:text-xl text-base-content/60 max-w-2xl mx-auto mb-10">
                        Write in Markdown and see the formatted output inline.
                        No account, no cloud — your files stay on your device.
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                        <Link
                            href="/editor"
                            className="btn btn-accent btn-lg min-w-48"
                        >
                            Try DOMD Online
                        </Link>
                        <a
                            href="#download"
                            className="btn btn-ghost btn-lg min-w-48"
                        >
                            Download for Mac
                        </a>
                    </div>
                </section>

                {/* Features */}
                <section
                    id="features"
                    className="max-w-5xl mx-auto px-6 py-20 scroll-mt-16"
                >
                    <h2 className="text-3xl font-bold mb-12 text-center">
                        Features
                    </h2>
                    <div className="grid md:grid-cols-2 gap-10">
                        <Feature
                            title="WYSIWYG Markdown"
                            body="No split preview. You write Markdown, it renders live, right where you type."
                        />
                        <Feature
                            title="Zero friction"
                            body="No account, no sign-up, no cloud sync. Open a file and start writing."
                        />
                        <Feature
                            title="Browser or native"
                            body="Use DOMD in any modern browser, or download the macOS app for full Finder integration."
                        />
                        <Feature
                            title="GitHub-friendly"
                            body="Paste any github.com URL or gh:owner/repo shorthand to open a README or markdown file."
                        />
                    </div>
                </section>

                {/* Online */}
                <section
                    id="online"
                    className="bg-base-200 py-20 scroll-mt-16"
                >
                    <div className="max-w-5xl mx-auto px-6 text-center">
                        <h2 className="text-3xl font-bold mb-4">
                            DOMD Online
                        </h2>
                        <p className="text-base-content/60 max-w-xl mx-auto mb-8">
                            Nothing to install. Drop a{" "}
                            <code className="text-sm">.md</code> file or paste
                            a URL — DOMD opens it instantly in your browser.
                        </p>
                        <Link
                            href="/editor"
                            className="btn btn-accent btn-lg min-w-48"
                        >
                            Open DOMD Online
                        </Link>
                        <p className="text-xs text-base-content/40 mt-6">
                            Works best in Chrome, Edge, or any Chromium-based
                            browser that supports the File System Access API.
                        </p>
                    </div>
                </section>

                {/* Download */}
                <section
                    id="download"
                    className="max-w-5xl mx-auto px-6 py-20 text-center scroll-mt-16"
                >
                    <h2 className="text-3xl font-bold mb-4">
                        Download for macOS
                    </h2>
                    <p className="text-base-content/60 max-w-xl mx-auto mb-8">
                        Native macOS build for Apple Silicon (M1 / M2 / M3 /
                        M4). Opens{" "}
                        <code className="text-sm">.md</code> files directly
                        from Finder, with system menus and save dialogs.
                    </p>
                    <a
                        href={MAC_DOWNLOAD_URL}
                        className="btn btn-accent btn-lg min-w-48"
                    >
                        Download for Mac (Apple Silicon)
                    </a>
                    <p className="text-xs text-base-content/40 mt-6">
                        Intel and Windows builds are not yet available.
                    </p>
                </section>
            </main>

            <footer className="border-t border-base-300 py-8">
                <div className="max-w-5xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-base-content/50">
                    <span>© {new Date().getFullYear()} DOMD</span>
                    <span>A clean place to write Markdown.</span>
                </div>
            </footer>
        </div>
    );
}

function Feature({ title, body }: { title: string; body: string }) {
    return (
        <div className="p-6 rounded-lg border border-base-300 bg-base-100">
            <h3 className="text-lg font-semibold mb-2">{title}</h3>
            <p className="text-sm text-base-content/60 leading-relaxed">
                {body}
            </p>
        </div>
    );
}
