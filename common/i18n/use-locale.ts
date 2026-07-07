"use client";
import { useCallback, useSyncExternalStore } from "react";
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import i18n from "./index";
import {
    DEFAULT_LOCALE,
    LOCALE_STORAGE_KEY,
    isLocale,
    type Locale,
} from "./config";

// Tell the Rust backend to rebuild the native menu in `locale` so the macOS
// menu bar stays in sync with the webview's language. No-op on web.
export function syncNativeLocale(locale: Locale): void {
    if (!isTauri()) return;
    tauriCore()
        .then(({ invoke }) => invoke("set_locale", { locale }))
        .catch(() => {
            // Older desktop build without the set_locale command — ignore.
        });
}

// Subscribe to i18next's current language without pulling in the full
// useTranslation machinery — handy for the language switcher. i18next is the
// single source of truth for the active locale; we mirror the user's explicit
// choice into localStorage so it survives reloads and future sessions.
function subscribe(cb: () => void): () => void {
    i18n.on("languageChanged", cb);
    return () => i18n.off("languageChanged", cb);
}

function getSnapshot(): Locale {
    return isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
}

export function useLocale() {
    const locale = useSyncExternalStore(
        subscribe,
        getSnapshot,
        () => DEFAULT_LOCALE, // server snapshot — deterministic
    );

    const setLocale = useCallback((next: Locale) => {
        try {
            localStorage.setItem(LOCALE_STORAGE_KEY, next);
        } catch {
            // persistence is best-effort (private mode / storage disabled)
        }
        void i18n.changeLanguage(next);
        // Keep the Tauri native menu in sync with the webview language.
        syncNativeLocale(next);
    }, []);

    return { locale, setLocale };
}
