"use client";
import Link from "next/link";
import { useTranslation } from "react-i18next";

// Client header for the landing page: nav links + GitHub. Extracted from the
// (server) page so the nav labels can be translated (language follows the
// system locale; there is no in-app switcher) while the page itself stays a
// Server Component.
export function LandingHeader() {
    const { t } = useTranslation();
    return (
        <header className="sticky top-0 z-20 bg-base-100/90 backdrop-blur border-b border-base-300">
            <nav className="max-w-3xl mx-auto flex items-center justify-between px-6 h-14">
                <a
                    href="https://github.com/do-md/domd"
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={t("common.github")}
                    className="btn btn-ghost btn-circle"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="w-8 h-8"
                    >
                        <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.683-.217.683-.483 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
                        />
                    </svg>
                </a>
                <div className="flex items-center gap-1 sm:gap-2">
                    <Link
                        href="/editor"
                        className="btn btn-link no-underline hover:underline px-2"
                        style={{ color: "rgb(60, 124, 171)" }}
                    >
                        {t("nav.editor")}
                    </Link>
                    <Link
                        href="/playground"
                        className="btn btn-link no-underline hover:underline px-2"
                        style={{ color: "rgb(60, 124, 171)" }}
                    >
                        {t("nav.stream")}
                    </Link>
                    <Link
                        href="/chat"
                        className="btn btn-link no-underline hover:underline px-2"
                        style={{ color: "rgb(60, 124, 171)" }}
                    >
                        {t("nav.input")}
                    </Link>
                </div>
            </nav>
        </header>
    );
}
