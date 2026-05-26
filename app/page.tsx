import Link from "next/link";
import { TauriRedirect } from "@/features/landing";

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
                            href="https://github.com/do-md/domd/releases/latest/download/DOMD_0.1.0_aarch64.dmg"
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
