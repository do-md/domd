import i18n from "@/common/i18n";
import type { ChatMessage, Provider, StreamSource } from "./types";

const ENDPOINTS: Record<Provider, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export class ChatStreamError extends Error {}

function toApiMessages(messages: ChatMessage[]) {
    return messages
        .filter((m) => m.status !== "error")
        .map((m) => ({ role: m.role, content: m.markdown }));
}

/**
 * Real BYOK streaming against an OpenAI-compatible chat-completions endpoint
 * (OpenAI and OpenRouter both qualify). Runs entirely in the browser — the key
 * never touches a DOMD server. Yields the incremental `delta.content` of each
 * SSE event so the caller can insert chunks as they arrive.
 */
export function realStreamSource(
    apiKey: string,
    provider: Provider,
    model: string,
    history: ChatMessage[],
): StreamSource {
    return async function* () {
        let res: Response;
        try {
            res = await fetch(ENDPOINTS[provider], {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    stream: true,
                    messages: toApiMessages(history),
                }),
            });
        } catch {
            // fetch rejects on DNS/offline/CORS — treat as a network failure.
            throw new ChatStreamError(i18n.t("chat.errors.network"));
        }

        if (res.status === 401 || res.status === 403) {
            throw new ChatStreamError(i18n.t("chat.errors.auth"));
        }
        if (!res.ok || !res.body) {
            throw new ChatStreamError(i18n.t("chat.errors.generic"));
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE events are separated by blank lines; process complete lines
            // and keep the trailing partial in the buffer.
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const raw of lines) {
                const line = raw.trim();
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "" || data === "[DONE]") continue;
                try {
                    const json = JSON.parse(data);
                    const delta: string | undefined =
                        json?.choices?.[0]?.delta?.content;
                    if (delta) yield delta;
                } catch {
                    // Ignore keep-alive comments / malformed partials.
                }
            }
        }
    };
}
