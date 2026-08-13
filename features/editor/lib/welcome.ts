/**
 * First-open welcome tour (web mode).
 *
 * When the editor would otherwise open a truly blank document AND this
 * browser has never shown the tour, the blank is seeded with a short
 * localized feature tour (AI collaborators, real-time collaboration,
 * rich/markdown display modes). Existing local data always wins: a saved
 * draft or an active collaboration session renders untouched — resolving any
 * source just marks the tour as seen so it never surfaces for users who
 * already have content.
 *
 * The seeded document is an ordinary document: the local-draft mirror picks
 * it up, so from the next load it simply IS the user's data.
 */
import i18n from "@/common/i18n";
import { resolveInitialLocale } from "@/common/i18n/config";
import { isApplePlatform } from "@/common/lib/format-shortcuts";
import { MODE_TOGGLE_SHORTCUT } from "./editor-mode";

const WELCOME_SEEN_KEY = "domd:welcome-seen";

/** Shown in the top bar and used as the download name — keep it ASCII. */
export const WELCOME_DOC_NAME = "Welcome.md";

export function hasSeenWelcome(): boolean {
    try {
        return localStorage.getItem(WELCOME_SEEN_KEY) !== null;
    } catch {
        // Storage unavailable (privacy mode etc.): pretend seen, otherwise
        // the tour would reappear on every single load.
        return true;
    }
}

export function markWelcomeSeen(): void {
    try {
        localStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch {
        // Best-effort only.
    }
}

/**
 * Assemble the tour markdown in the BROWSER language directly rather than
 * through the i18next singleton's current language: this runs in the editor
 * mount effect, which fires BEFORE the I18nProvider effect switches i18next
 * away from its English boot locale (child effects run first).
 */
export function buildWelcomeMarkdown(): string {
    const t = i18n.getFixedT(resolveInitialLocale());
    const shortcut = isApplePlatform()
        ? MODE_TOGGLE_SHORTCUT.mac
        : MODE_TOGGLE_SHORTCUT.other;
    return [
        `# ${t("editor.welcome.title")}`,
        "",
        t("editor.welcome.intro"),
        "",
        `## 🤖 ${t("editor.welcome.aiTitle")}`,
        "",
        t("editor.welcome.aiBody"),
        "",
        `## 👥 ${t("editor.welcome.collabTitle")}`,
        "",
        t("editor.welcome.collabBody"),
        "",
        `## ✍️ ${t("editor.welcome.modeTitle")}`,
        "",
        t("editor.welcome.modeBody", { shortcut }),
        "",
        t("editor.welcome.outro"),
        "",
    ].join("\n");
}
