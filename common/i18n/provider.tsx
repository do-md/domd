"use client";
import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "./index";
import { resolveInitialLocale } from "./config";

// Wraps the app so every client component can useTranslation(). Server
// components pass through as `children` (composition) and stay server-rendered.
//
// The switch-after-mount pattern: i18n boots in DEFAULT_LOCALE (see index.ts)
// so hydration matches, then here — once on the client — we resolve the user's
// real locale (localStorage > navigator) and switch. Non-English users see a
// one-paint flash of English; that's the standard trade-off for a static-export
// client app and avoids any hydration mismatch.
export function I18nProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        const target = resolveInitialLocale();
        if (i18n.language !== target) {
            void i18n.changeLanguage(target);
        }
        document.documentElement.lang = target;

        const onChange = (lng: string) => {
            document.documentElement.lang = lng;
        };
        i18n.on("languageChanged", onChange);
        return () => {
            i18n.off("languageChanged", onChange);
        };
    }, []);

    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
