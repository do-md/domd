"use client";
import { useTranslation } from "react-i18next";

// Client footer for the landing page. The year is computed on the client; the
// copyright + tagline are translated at runtime.
export function LandingFooter({ year }: { year: number }) {
    const { t } = useTranslation();
    return (
        <footer className="border-t border-base-300 py-8">
            <div className="max-w-3xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-2 text-sm text-base-content/50">
                <span>{t("landing.copyright", { year })}</span>
                <span>{t("landing.tagline")}</span>
            </div>
        </footer>
    );
}
