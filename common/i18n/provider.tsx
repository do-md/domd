"use client";
import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import i18n from "./index";
import { resolveInitialLocale, type Locale } from "./config";

// Tell the Rust backend to (re)build the native menu in `locale` so the macOS
// menu bar matches the webview's language. No-op on web.
function syncNativeLocale(locale: Locale): void {
    if (!isTauri()) return;
    tauriCore()
        .then(({ invoke }) => invoke("set_locale", { locale }))
        .catch(() => {
            // Older desktop build without the set_locale command — ignore.
        });
}

// Wraps the app so every client component can useTranslation(). Server
// components pass through as `children` (composition) and stay server-rendered.
//
// Language follows the system/browser locale — there is no in-app switcher.
// i18n boots in DEFAULT_LOCALE (see index.ts) so SSR/static-export hydration
// matches, then here — once on the client — we resolve the OS locale
// (navigator) and switch. Non-English users see a one-paint flash of English;
// that's the standard trade-off for a static-export client app.
export function I18nProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        const target = resolveInitialLocale();
        if (i18n.language !== target) {
            void i18n.changeLanguage(target);
        }
        document.documentElement.lang = target;
        // Desktop: align the native menu (built with the OS locale at launch)
        // with the locale the webview resolved to. No-op on web.
        syncNativeLocale(target);
    }, []);

    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
