"use client";
import { useTranslation } from "react-i18next";
import { useLocale } from "@/common/i18n/use-locale";
import { LOCALE_NAMES, SUPPORTED_LOCALES } from "@/common/i18n/config";

// DaisyUI dropdown language switcher. Renders the current locale's native name
// and lets the user pick another. Kept presentation-light so it drops into any
// header (landing nav, editor top bar) via className.
export function LanguageSwitcher({ className = "" }: { className?: string }) {
    const { t } = useTranslation();
    const { locale, setLocale } = useLocale();

    return (
        <div className={`dropdown dropdown-end ${className}`}>
            <div
                tabIndex={0}
                role="button"
                className="btn btn-ghost btn-sm gap-1"
                aria-label={t("common.language")}
                title={t("common.language")}
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                <span className="text-xs">{LOCALE_NAMES[locale]}</span>
            </div>
            <ul
                tabIndex={0}
                className="dropdown-content menu menu-sm z-50 mt-1 w-32 rounded-box bg-base-100 p-1 shadow border border-base-300"
            >
                {SUPPORTED_LOCALES.map((lng) => (
                    <li key={lng}>
                        <button
                            type="button"
                            className={locale === lng ? "active" : ""}
                            onClick={() => {
                                setLocale(lng);
                                // close the dropdown by blurring the focused menu
                                (document.activeElement as HTMLElement)?.blur();
                            }}
                        >
                            {LOCALE_NAMES[lng]}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
