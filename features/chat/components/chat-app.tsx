"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { mockStreamSource } from "../lib/mock";
import { realStreamSource } from "../lib/stream";
import { PROVIDERS, type ChatMessage, type Provider } from "../lib/types";
import type { StreamSource } from "../lib/types";
import { AssistantMessage } from "./assistant-message";
import { ChatIntro, EmptyState } from "./chat-intro";
import { ConfigModal } from "./config-modal";
import { DomdChatInput, type DomdChatInputHandle } from "./domd-chat-input";
import { UserMessage } from "./user-message";

const EXAMPLE_PROMPT = "Show me a Markdown table and a TypeScript code block.";

// BYOK config persisted to localStorage (browser-only; never sent to a server).
const LS_KEY = "domd-chat:apiKey";
const LS_PROVIDER = "domd-chat:provider";
const LS_MODEL = "domd-chat:model";

function lsSet(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // private mode / storage disabled — persistence is best-effort.
    }
}

const newId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// State entry = the public message plus the (non-serializable) stream source
// the assistant renderer consumes once. Kept on the entry rather than a side
// ref so nothing is read from a ref during render.
type ChatEntry = ChatMessage & { source?: StreamSource };

export function ChatApp() {
    const [apiKey, setApiKey] = useState("");
    const [provider, setProvider] = useState<Provider>("openai");
    const [model, setModel] = useState(PROVIDERS[0].defaultModel);
    const [messages, setMessages] = useState<ChatEntry[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const [configOpen, setConfigOpen] = useState(false);

    const isMock = apiKey.trim().length === 0;
    const inputRef = useRef<DomdChatInputHandle>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Anchor-to-top: after a send, scroll the new user message to the top and
    // reserve room below it (a min-height on the freshly-added assistant turn)
    // so the streaming reply has a full viewport to fill — like ChatGPT.
    const messageRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
    const anchorRef = useRef<{ userId: string; assistantId: string } | null>(
        null,
    );
    const [reserve, setReserve] = useState<{
        id: string;
        minHeight: number;
    } | null>(null);

    const setMessageRef = useCallback(
        (id: string, el: HTMLDivElement | null) => {
            if (el) messageRefsMap.current.set(id, el);
            else messageRefsMap.current.delete(id);
        },
        [],
    );

    // Load persisted config once on mount. Done in an effect (not a lazy state
    // initializer) on purpose: SSR and the first client render both start from
    // defaults so there's no hydration mismatch, then the stored values fill in.
    // The set-state-in-effect this requires is the intended pattern here.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        try {
            const k = localStorage.getItem(LS_KEY);
            const p = localStorage.getItem(LS_PROVIDER);
            const m = localStorage.getItem(LS_MODEL);
            if (k) setApiKey(k);
            if (p === "openai" || p === "openrouter") setProvider(p);
            if (m) setModel(m);
        } catch {
            // storage unavailable — fall back to defaults (mock mode).
        }
    }, []);
    /* eslint-enable react-hooks/set-state-in-effect */

    const persistApiKey = useCallback((v: string) => {
        setApiKey(v);
        lsSet(LS_KEY, v);
    }, []);

    const persistModel = useCallback((v: string) => {
        setModel(v);
        lsSet(LS_MODEL, v);
    }, []);

    // When the provider changes, reset the model to that provider's default
    // (the user can then override it). Persist both.
    const onProviderChange = useCallback((p: Provider) => {
        setProvider(p);
        lsSet(LS_PROVIDER, p);
        const def = PROVIDERS.find((x) => x.id === p)?.defaultModel;
        if (def) {
            setModel(def);
            lsSet(LS_MODEL, def);
        }
    }, []);

    const handleSubmit = useCallback(
        (markdown: string) => {
            const text = markdown.trim();
            if (!text || isStreaming) return;

            const userMsg: ChatEntry = {
                id: newId(),
                role: "user",
                markdown: text,
                status: "done",
            };

            // Real streaming includes the just-sent user turn in the history.
            const source: StreamSource = isMock
                ? mockStreamSource()
                : realStreamSource(apiKey.trim(), provider, model, [
                      ...messages,
                      userMsg,
                  ]);
            const assistantMsg: ChatEntry = {
                id: newId(),
                role: "assistant",
                markdown: "",
                status: "streaming",
                isMock,
                source,
            };

            anchorRef.current = {
                userId: userMsg.id,
                assistantId: assistantMsg.id,
            };
            setMessages((prev) => [...prev, userMsg, assistantMsg]);
            setIsStreaming(true);
        },
        [apiKey, provider, model, isStreaming, messages, isMock],
    );

    const handleDone = useCallback((id: string, md: string) => {
        setMessages((prev) =>
            prev.map((m) =>
                m.id === id
                    ? { ...m, markdown: md, status: "done", source: undefined }
                    : m,
            ),
        );
        setIsStreaming(false);
    }, []);

    const handleError = useCallback((id: string, md: string) => {
        setMessages((prev) =>
            prev.map((m) =>
                m.id === id
                    ? { ...m, markdown: md, status: "error", source: undefined }
                    : m,
            ),
        );
        setIsStreaming(false);
    }, []);

    const tryExample = useCallback(() => {
        inputRef.current?.setMarkdown(EXAMPLE_PROMPT);
    }, []);

    // After a send: reserve a viewport-sized block under the new turn, then
    // scroll the user message to the top so the streaming reply has room below.
    // Measuring/scrolling happens here (in an effect, post-layout) — never by
    // reading a ref during render.
    useEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        anchorRef.current = null;

        const container = scrollRef.current;
        const userEl = messageRefsMap.current.get(anchor.userId);
        if (!container || !userEl) return;

        // Reserve ≈ viewport minus the user message so user + reply ≈ one screen.
        const minHeight = Math.max(
            0,
            container.clientHeight - userEl.offsetHeight - 24,
        );
        setReserve({ id: anchor.assistantId, minHeight });

        // Custom smooth scroll — scrollIntoView's "smooth" duration is fixed by
        // the browser (and on the slow side). A short rAF animation feels
        // snappier. Two rAFs first so the reserved min-height has committed and
        // the target is reachable.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Leave a little breathing room above the "You" label instead
                // of pinning it flush to the very top.
                const TOP_GAP = 20;
                const start = container.scrollTop;
                const target = Math.max(
                    0,
                    start +
                        (userEl.getBoundingClientRect().top -
                            container.getBoundingClientRect().top) -
                        TOP_GAP,
                );
                const DURATION = 200;
                const ease = (t: number) => 1 - Math.pow(1 - t, 3);
                let startTime = 0;
                const step = (now: number) => {
                    if (!startTime) startTime = now;
                    const p = Math.min(1, (now - startTime) / DURATION);
                    container.scrollTop = start + (target - start) * ease(p);
                    if (p < 1) requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            });
        });
    }, [messages]);

    return (
        <div className="fixed inset-0 flex flex-col bg-base-100 text-base-content overflow-hidden">
            <header className="shrink-0 h-12 flex items-center justify-between px-3 md:px-4 bg-base-200 border-b border-base-300">
                <div className="flex items-center gap-2 min-w-0">
                    <Link
                        href="/"
                        className="btn btn-ghost btn-xs"
                        aria-label="Home"
                    >
                        ←
                    </Link>
                    <span className="font-semibold text-sm truncate">
                        DOMD Playground
                    </span>
                    <span className="hidden sm:inline text-xs text-base-content/50 truncate">
                        Markdown-native AI chat
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setConfigOpen(true)}
                        className="btn btn-ghost btn-circle"
                        aria-label="Chat settings"
                        title="Chat settings"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.8}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="w-5 h-5"
                        >
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                    </button>
                    <a
                        href="https://github.com/do-md/domd"
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label="GitHub"
                        className="btn btn-ghost btn-circle"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            className="w-8 h-8"
                        >
                            <path
                                fillRule="evenodd"
                                clipRule="evenodd"
                                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.683-.217.683-.483 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
                            />
                        </svg>
                    </a>
                </div>
            </header>

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
                <main className="mx-auto max-w-3xl w-full px-4 sm:px-6 py-6 flex flex-col gap-5">
                    {messages.length === 0 ? (
                        <>
                            <ChatIntro />
                            <EmptyState onTryExample={tryExample} />
                        </>
                    ) : (
                        <div className="flex flex-col gap-5">
                            {messages.map((m) => (
                                <div
                                    key={m.id}
                                    ref={(el) => setMessageRef(m.id, el)}
                                    style={
                                        reserve?.id === m.id
                                            ? { minHeight: reserve.minHeight }
                                            : undefined
                                    }
                                >
                                    {m.role === "user" ? (
                                        <UserMessage message={m} />
                                    ) : (
                                        <AssistantMessage
                                            message={m}
                                            source={m.source}
                                            onDone={handleDone}
                                            onError={handleError}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </main>
            </div>

            <div className="shrink-0 border-t border-base-300 bg-base-200/40">
                <div className="mx-auto max-w-3xl w-full px-4 sm:px-6 py-3">
                    <DomdChatInput
                        ref={inputRef}
                        onSubmit={handleSubmit}
                        disabled={isStreaming}
                    />
                </div>
            </div>

            <ConfigModal
                open={configOpen}
                onClose={() => setConfigOpen(false)}
                apiKey={apiKey}
                onApiKeyChange={persistApiKey}
                provider={provider}
                onProviderChange={onProviderChange}
                model={model}
                onModelChange={persistModel}
            />
        </div>
    );
}
