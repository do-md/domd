export type AiProvider = "openai" | "openrouter";

export const AI_PROVIDERS: {
    id: AiProvider;
    label: string;
    defaultModel: string;
}[] = [
    { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
    {
        id: "openrouter",
        label: "OpenRouter",
        defaultModel: "anthropic/claude-3.5-haiku",
    },
];

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
