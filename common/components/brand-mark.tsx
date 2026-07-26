"use client";
/**
 * Shared top-bar brand block for app pages (/editor, /collab): DOMD wordmark
 * linking home, the collaborative-document subtitle, and a GitHub link
 * (same repo target as the landing header).
 */
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { DEFAULT_LOCALE } from "@/common/i18n/config";
import { useHydrated } from "@/common/lib/use-hydrated";

function GitHubIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.683-.217.683-.483 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
            />
        </svg>
    );
}

export function BrandMark() {
    const { t } = useTranslation();
    // BrandMark ships in the server HTML of Suspense-wrapped pages
    // (/editor and /collab loading shells), and those boundaries can
    // hydrate AFTER the provider's post-mount language switch. Render
    // DEFAULT_LOCALE strings for the hydration pass so client and server
    // agree, then re-render with the live locale (see useHydrated).
    const hydrated = useHydrated();
    const ts = (key: string): string =>
        hydrated ? t(key) : t(key, { lng: DEFAULT_LOCALE });
    return (
        <div className="flex items-center gap-2 min-w-0">
            <a
                href="https://github.com/do-md/domd"
                target="_blank"
                rel="noreferrer noopener"
                aria-label={ts("common.github")}
                className="shrink-0 text-base-content hover:opacity-70"
            >
                <GitHubIcon className="size-5" />
            </a>
            <Link
                href="/"
                className="font-semibold text-sm text-base-content hover:opacity-70 shrink-0"
            >
                DOMD
            </Link>
            <span className="text-xs text-base-content/40 truncate">
                {ts("collab.guestHeader")}
            </span>
        </div>
    );
}
