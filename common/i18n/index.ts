// i18next singleton for DOMD. Pure client-side runtime i18n — no server
// dependency — so it works identically under Next.js static export (Tauri
// desktop build) and the Vercel web deploy. Non-React code (save-document.ts,
// stream.ts, updater dialogs) imports this `i18n` and calls `i18n.t(...)`
// directly; React components use `useTranslation()` from react-i18next.
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./config";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";

// IMPORTANT: initialize with DEFAULT_LOCALE (not the detected one) so the
// server-rendered HTML (static export / first paint) and the first client
// render agree — no hydration mismatch. provider.tsx switches to the resolved
// locale in a mount effect, after hydration.
if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
        resources: {
            en: { translation: en },
            zh: { translation: zh },
            ja: { translation: ja },
        },
        lng: DEFAULT_LOCALE,
        fallbackLng: DEFAULT_LOCALE,
        supportedLngs: SUPPORTED_LOCALES as unknown as string[],
        interpolation: { escapeValue: false }, // React already escapes
        returnNull: false,
    });
}

export default i18next;
