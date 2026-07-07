// Single source of truth for the locales DOMD ships. Keep this list in sync
// with the JSON dictionaries under ./locales and the Rust-side menu strings
// (src-tauri: menu_i18n), which reuse the SAME translation source.
export const SUPPORTED_LOCALES = ["en", "zh", "ja"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Map any BCP-47 tag to one of our shipped locales (zh-CN -> zh, ja-JP -> ja).
// Mirrors the Rust-side menu_i18n::normalize so both consumers agree.
export function normalizeLocale(tag: string | null | undefined): Locale | null {
    if (!tag) return null;
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("ja")) return "ja";
    if (lower.startsWith("en")) return "en";
    return null;
}

// Resolve the locale to boot with on the client — DOMD follows the system /
// browser locale (there is no in-app switcher). Walks navigator.languages in
// order, falling back to DEFAULT_LOCALE. Runs only in the browser; on the
// server it returns DEFAULT_LOCALE so static export / first paint is
// deterministic.
export function resolveInitialLocale(): Locale {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
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
