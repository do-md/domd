// Single source of truth for the locales DOMD ships. Keep this list in sync
// with the JSON dictionaries under ./locales and (Phase 3) the Rust-side menu
// strings, which reuse the SAME translation keys.
export const SUPPORTED_LOCALES = ["en", "zh", "ja"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Native names shown in the language switcher (each in its own language).
export const LOCALE_NAMES: Record<Locale, string> = {
    en: "English",
    zh: "中文",
    ja: "日本語",
};

// Where the user's explicit choice is persisted. Read before hydration is not
// possible for i18next state (it lives in JS), so we init in DEFAULT_LOCALE on
// the server/first paint, then switch on mount — see provider.tsx.
export const LOCALE_STORAGE_KEY = "domd:locale";

export function isLocale(v: unknown): v is Locale {
    return (
        typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v)
    );
}

// Map any BCP-47 tag to one of our shipped locales (zh-CN -> zh, ja-JP -> ja).
export function normalizeLocale(tag: string | null | undefined): Locale | null {
    if (!tag) return null;
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("ja")) return "ja";
    if (lower.startsWith("en")) return "en";
    return null;
}

// Resolve the locale to boot with on the client. Priority:
//   1. explicit user choice (localStorage)
//   2. browser preferences (navigator.languages, in order)
//   3. DEFAULT_LOCALE
// Runs only in the browser; on the server it returns DEFAULT_LOCALE so static
// export / first paint is deterministic.
export function resolveInitialLocale(): Locale {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    try {
        const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
        if (isLocale(stored)) return stored;
    } catch {
        // localStorage blocked (private mode) — fall through to navigator.
    }
    const langs =
        typeof navigator === "undefined"
            ? []
            : navigator.languages?.length
              ? navigator.languages
              : [navigator.language];
    for (const raw of langs) {
        const hit = normalizeLocale(raw);
        if (hit) return hit;
    }
    return DEFAULT_LOCALE;
}
