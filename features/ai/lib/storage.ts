/**
 * Persistence for AI collaboration config (agents, provider API keys,
 * enabled flag, local collaborator id). Two backends behind one synchronous
 * API:
 *
 *  - Web: plain localStorage (same pattern as features/chat — try/catch for
 *    private mode, defaults first so SSR and the first client render agree).
 *  - Desktop: ~/.domd/ai.json via the load_ai_config/save_ai_config
 *    commands, next to the rest of the app's data (collab.db, assets/) —
 *    user-visible, backupable, and not hostage to webview site data. The
 *    file is hydrated ONCE into an in-memory cache at startup
 *    (hydrateAiConfig, awaited before the first read), after which every
 *    load stays synchronous against the cache and every save updates the
 *    cache and persists through a serialized write chain. On first desktop
 *    run the old localStorage config is migrated into the file and cleared.
 *
 * If hydration fails (unreadable/corrupt file), the desktop build falls
 * back to localStorage so AI collaboration keeps working — with a console
 * warning, since edits then won't reach ai.json.
 */
import { isTauri } from "@/common/lib/platform";
import { tauriCore } from "@/common/lib/tauri";
import { AI_PROVIDERS, type AgentConfig, type AiProvider } from "./types";

const LS_AGENTS = "domd-ai:agents";
const LS_ENABLED = "domd-ai:enabled";
const LS_SELF_ID = "domd-ai:selfId";
const lsKeyFor = (provider: AiProvider) => `domd-ai:key:${provider}`;

const lsGet = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const lsSet = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Private mode / quota — config simply won't persist.
    }
};

const lsRemove = (key: string) => {
    try {
        localStorage.removeItem(key);
    } catch {
        // Ignore — worst case the migrated values linger in localStorage.
    }
};

const parseAgents = (raw: string | null): AgentConfig[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as AgentConfig[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

// ── Desktop backend (~/.domd/ai.json) ───────────────────────────────────────

interface DesktopAiConfig {
    enabled?: boolean;
    agents?: AgentConfig[];
    keys?: Partial<Record<AiProvider, string>>;
    selfId?: string;
}

/** Non-null exactly when the desktop file backend is active (hydrated). */
let desktopConfig: DesktopAiConfig | null = null;

/** Writes are serialized so a slow invoke can't land after a newer one. */
let persistChain: Promise<void> = Promise.resolve();

const persistDesktop = () => {
    const snapshot = JSON.stringify(desktopConfig, null, 2);
    persistChain = persistChain
        .then(async () => {
            const { invoke } = await tauriCore();
            await invoke("save_ai_config", { content: snapshot });
        })
        .catch((err) => {
            console.warn("[ai-config] save failed:", err);
        });
};

/**
 * Desktop: load ~/.domd/ai.json into the in-memory cache (migrating any
 * pre-existing localStorage config on first run). Web: no-op. Await this
 * before the first load* call — editor-app's mount effect does.
 */
export async function hydrateAiConfig(): Promise<void> {
    if (!isTauri() || desktopConfig !== null) return;
    try {
        const { invoke } = await tauriCore();
        const raw = await invoke<string | null>("load_ai_config");
        if (raw !== null) {
            const parsed = JSON.parse(raw) as DesktopAiConfig;
            if (typeof parsed !== "object" || parsed === null) {
                throw new Error("ai.json is not an object");
            }
            desktopConfig = parsed;
            return;
        }
        // First desktop run: carry over whatever the webview's localStorage
        // holds from before the file backend existed, then clear it — the
        // file is the single source of truth now (and API keys should not
        // linger in two places).
        const keys: Partial<Record<AiProvider, string>> = {};
        for (const { id } of AI_PROVIDERS) {
            const key = lsGet(lsKeyFor(id));
            if (key) keys[id] = key;
        }
        desktopConfig = {
            enabled: lsGet(LS_ENABLED) === "1",
            agents: parseAgents(lsGet(LS_AGENTS)),
            keys,
            selfId: lsGet(LS_SELF_ID) ?? undefined,
        };
        persistDesktop();
        lsRemove(LS_AGENTS);
        lsRemove(LS_ENABLED);
        lsRemove(LS_SELF_ID);
        for (const { id } of AI_PROVIDERS) lsRemove(lsKeyFor(id));
    } catch (err) {
        console.warn(
            "[ai-config] hydrate failed; falling back to localStorage:",
            err,
        );
        desktopConfig = null;
    }
}

// ── Public API (synchronous on both backends) ───────────────────────────────

export const loadAgents = (): AgentConfig[] => {
    if (desktopConfig) {
        return Array.isArray(desktopConfig.agents) ? desktopConfig.agents : [];
    }
    return parseAgents(lsGet(LS_AGENTS));
};

export const saveAgents = (agents: AgentConfig[]) => {
    if (desktopConfig) {
        desktopConfig.agents = agents;
        persistDesktop();
        return;
    }
    lsSet(LS_AGENTS, JSON.stringify(agents));
};

export const loadAiEnabled = (): boolean => {
    if (desktopConfig) return desktopConfig.enabled === true;
    return lsGet(LS_ENABLED) === "1";
};

export const saveAiEnabled = (enabled: boolean) => {
    if (desktopConfig) {
        desktopConfig.enabled = enabled;
        persistDesktop();
        return;
    }
    lsSet(LS_ENABLED, enabled ? "1" : "0");
};

export const loadApiKey = (provider: AiProvider): string => {
    if (desktopConfig) return desktopConfig.keys?.[provider] ?? "";
    return lsGet(lsKeyFor(provider)) ?? "";
};

export const saveApiKey = (provider: AiProvider, key: string) => {
    if (desktopConfig) {
        desktopConfig.keys = { ...desktopConfig.keys, [provider]: key };
        persistDesktop();
        return;
    }
    lsSet(lsKeyFor(provider), key);
};

/** Durable local collaborator id for the versioning session the host mounts
 *  while AI collaboration is enabled without a live room. Persisted so
 *  authorship stays attributable across page sessions. */
export const localSelfClientId = (): string => {
    if (desktopConfig) {
        if (desktopConfig.selfId) return desktopConfig.selfId;
        const id = `local-${Math.random().toString(36).slice(2, 10)}`;
        desktopConfig.selfId = id;
        persistDesktop();
        return id;
    }
    const existing = lsGet(LS_SELF_ID);
    if (existing) return existing;
    const id = `local-${Math.random().toString(36).slice(2, 10)}`;
    lsSet(LS_SELF_ID, id);
    return id;
};
