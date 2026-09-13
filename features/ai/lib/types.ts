/** Provider id — either a built-in preset ("openai" / "openrouter") or the
 *  generated id of a user-defined custom endpoint ("custom-xxxxxxxx"). */
export type AiProvider = string;

export interface ProviderPreset {
    id: AiProvider;
    label: string;
    defaultModel: string;
    /** Full OpenAI-compatible chat-completions URL. */
    endpoint: string;
}

export const BUILTIN_PROVIDERS: ProviderPreset[] = [
    {
        id: "openai",
        label: "OpenAI",
        defaultModel: "gpt-4o-mini",
        endpoint: "https://api.openai.com/v1/chat/completions",
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        defaultModel: "anthropic/claude-3.5-haiku",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
    },
];

/**
 * A user-defined OpenAI-compatible endpoint: a reverse proxy, a provider we
 * ship no preset for (DeepSeek, Moonshot, …), or a local server. Stored
 * alongside the agents (localStorage on web, ~/.domd/ai.json on desktop) and
 * referenced by agents through its id, so several agents can share one
 * endpoint and its API key.
 */
export interface CustomProvider {
    id: AiProvider;
    label: string;
    /** As typed by the user; normalizeChatEndpoint turns it into a URL. */
    baseUrl: string;
}

const CUSTOM_PREFIX = "custom-";

export const isCustomProvider = (id: AiProvider): boolean =>
    id.startsWith(CUSTOM_PREFIX);

export const newCustomProviderId = (): AiProvider =>
    `${CUSTOM_PREFIX}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Turn whatever the user pasted into a chat-completions URL. All three
 * shapes people actually paste are accepted:
 *
 *   https://api.deepseek.com                  -> …/v1/chat/completions
 *   https://api.deepseek.com/v1               -> …/v1/chat/completions
 *   https://proxy.example/v1/chat/completions -> unchanged
 *
 * A trailing version segment (/v1, /v1beta, /openai/v1) marks the OpenAI
 * base-URL form; anything else is treated as a bare host and gets /v1. The
 * full-URL form is the escape hatch for gateways that route differently.
 */
export const normalizeChatEndpoint = (baseUrl: string): string => {
    const url = baseUrl.trim().replace(/\/+$/, "");
    if (!url) return "";
    if (/\/completions$/.test(url)) return url;
    return /\/v\d+[a-z]*$/.test(url)
        ? `${url}/chat/completions`
        : `${url}/v1/chat/completions`;
};

/** One user-configured AI agent. Persisted locally — localStorage on the
 *  web, ~/.domd/ai.json on desktop (see lib/storage.ts). */
export interface AgentConfig {
    id: string;
    name: string;
    provider: AiProvider;
    model: string;
    /** User-authored persona / standing instructions for this agent. */
    prompt: string;
    /** Presence color (muted palette — see AI_COLORS). */
    color: string;
}

/** Muted presence palette for agents (project style: no loud primaries). */
export const AI_COLORS = [
    "#8a7aa8",
    "#8fbcbb",
    "#d08770",
    "#a3be8c",
    "#b48ead",
];

export const pickAgentColor = (index: number): string =>
    AI_COLORS[index % AI_COLORS.length];

/** Durable collaborator identity for an agent (authorship, presence). */
export const agentClientId = (agent: AgentConfig): string => `ai-${agent.id}`;
