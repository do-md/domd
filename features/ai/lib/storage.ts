/**
 * Browser-local persistence for AI collaboration config (same pattern as
 * features/chat: plain localStorage, try/catch for private mode, defaults
 * first so SSR and the first client render agree).
 */
import type { AgentConfig, AiProvider } from "./types";

const LS_AGENTS = "domd-ai:agents";
const LS_ENABLED = "domd-ai:enabled";
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

export const loadAgents = (): AgentConfig[] => {
    const raw = lsGet(LS_AGENTS);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as AgentConfig[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

export const saveAgents = (agents: AgentConfig[]) => {
    lsSet(LS_AGENTS, JSON.stringify(agents));
};

export const loadAiEnabled = (): boolean => lsGet(LS_ENABLED) === "1";

export const saveAiEnabled = (enabled: boolean) => {
    lsSet(LS_ENABLED, enabled ? "1" : "0");
};

export const loadApiKey = (provider: AiProvider): string =>
    lsGet(lsKeyFor(provider)) ?? "";

export const saveApiKey = (provider: AiProvider, key: string) => {
    lsSet(lsKeyFor(provider), key);
};

const LS_SELF_ID = "domd-ai:selfId";

/** Durable local collaborator id for the versioning session the host mounts
 *  while AI collaboration is enabled without a live room. Persisted so
 *  authorship stays attributable across page sessions. */
export const localSelfClientId = (): string => {
    const existing = lsGet(LS_SELF_ID);
    if (existing) return existing;
    const id = `local-${Math.random().toString(36).slice(2, 10)}`;
    lsSet(LS_SELF_ID, id);
    return id;
};
