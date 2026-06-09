// Match the browser's preferred locale to one of the three languages we ship
// (en / zh / ja). Walks navigator.languages in order so a user with
// ["fr","zh-CN","en"] picks English (their primary), but ["zh-CN","en"] picks
// Chinese. Falls back to English for anything we don't ship.
export type Locale3<T> = { en: T; zh: T; ja: T };

export function pickByLocale<T>(opts: Locale3<T>): T {
    const langs =
        typeof navigator === "undefined"
            ? []
            : navigator.languages?.length
              ? navigator.languages
              : [navigator.language];
    for (const raw of langs) {
        const tag = (raw || "").toLowerCase();
        if (tag.startsWith("zh")) return opts.zh;
        if (tag.startsWith("ja")) return opts.ja;
        if (tag.startsWith("en")) return opts.en;
    }
    return opts.en;
}
