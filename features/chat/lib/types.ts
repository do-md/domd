export type ChatRole = "user" | "assistant";

export type ChatMessageStatus = "streaming" | "done" | "error";

export type ChatMessage = {
    id: string;
    role: ChatRole;
    markdown: string;
    status?: ChatMessageStatus;
    isMock?: boolean;
};

export type Provider = "openai" | "openrouter";

/**
 * A stream source is a thunk returning an async iterable of Markdown chunks.
 * Both mock and real streaming conform to this shape so the assistant renderer
 * can consume them identically (seed first chunk via resetMD, rest via
 * insertText).
 */
export type StreamSource = () => AsyncGenerator<string, void, unknown>;

export const PROVIDERS: { id: Provider; label: string; defaultModel: string }[] =
    [
        { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
        {
            id: "openrouter",
            label: "OpenRouter",
            defaultModel: "openai/gpt-4o-mini",
        },
    ];
