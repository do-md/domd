"use client";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
    DOMD,
    DOMDProvider,
    toMarkdown,
    useEditorStoreApi,
    useRenderData,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import i18n from "@/common/i18n";
import { ChatStreamError } from "../lib/stream";
import type { ChatMessage, StreamSource } from "../lib/types";

// The bordered content box, rendered inside the provider so it can watch the
// store. While the reply is still empty (before the first chunk arrives) we
// drop the border/background entirely — only the "streaming..." header shows —
// so there's no empty boxed row. The box appears once content streams in.
function AssistantBody() {
    const renderData = useRenderData();
    const isEmpty = (toMarkdown(renderData) ?? "").trim().length === 0;
    return (
        <div
            className={
                isEmpty
                    ? undefined
                    : "rounded-xl border border-base-300 bg-base-200/40 px-4 py-3"
            }
        >
            <DOMD />
        </div>
    );
}

// Drives a stream source into the surrounding DOMD store: the first chunk seeds
// the doc (resetMD gives it a cursor), subsequent chunks append via insertText.
// Markdown split mid-token across chunks is reconciled by DOMD as more arrives.
function StreamDriver({
    source,
    onDone,
    onError,
}: {
    source: StreamSource;
    onDone: (markdown: string) => void;
    onError: (markdown: string) => void;
}) {
    const store = useEditorStoreApi();

    // Read callbacks/source via refs so the run effect can depend only on
    // [store]. Otherwise the inline callbacks from the parent (new identity on
    // every messages-list re-render) would re-trigger the effect and cancel an
    // in-flight stream mid-way.
    const sourceRef = useRef(source);
    const onDoneRef = useRef(onDone);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        sourceRef.current = source;
        onDoneRef.current = onDone;
        onErrorRef.current = onError;
    });

    // Depend only on [store] (stable per provider). No once-guard: under React
    // StrictMode the effect mounts→unmounts→mounts; a ref guard would let the
    // first run get cancelled and block the second from ever streaming. Here
    // each mount runs the full stream and cleanup cancels — StrictMode's first
    // pass is cancelled, the second completes; production runs once.
    useEffect(() => {
        if (!store) return;
        let cancelled = false;
        let seeded = false;

        const put = (chunk: string) => {
            if (!seeded) {
                store.resetMD(chunk);
                seeded = true;
            } else {
                store.insertText(chunk);
            }
        };

        (async () => {
            try {
                for await (const chunk of sourceRef.current()) {
                    if (cancelled) return;
                    put(chunk);
                }
                if (!cancelled) onDoneRef.current(store.toMarkdown());
            } catch (err) {
                if (cancelled) return;
                const msg =
                    err instanceof ChatStreamError
                        ? err.message
                        : i18n.t("chat.errors.generic");
                if (!seeded) store.resetMD(msg);
                else store.insertText("\n\n" + msg);
                onErrorRef.current(store.toMarkdown());
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [store]);

    return null;
}

export function AssistantMessage({
    message,
    source,
    onDone,
    onError,
}: {
    message: ChatMessage;
    source?: StreamSource;
    onDone: (id: string, markdown: string) => void;
    onError: (id: string, markdown: string) => void;
}) {
    const streaming = message.status === "streaming";
    const error = message.status === "error";
    const { t } = useTranslation();

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-base-content/70">
                    {t("chat.message.assistant")}
                </span>
                {streaming ? (
                    <span className="inline-flex items-center gap-1 text-base-content/40">
                        <span className="loading loading-dots loading-xs" />
                        {t("chat.message.streaming")}
                    </span>
                ) : null}
                {message.isMock ? (
                    <span className="badge badge-ghost badge-sm">
                        {t("chat.message.mock")}
                    </span>
                ) : null}
                {error ? (
                    <span className="badge badge-error badge-sm">
                        {t("chat.message.error")}
                    </span>
                ) : null}
            </div>

            <DOMDProvider
                editable={false}
                initMd={message.markdown}
                codeTokenizer={tokenize}
            >
                <AssistantBody />
                {source ? (
                    <StreamDriver
                        source={source}
                        onDone={(md) => onDone(message.id, md)}
                        onError={(md) => onError(message.id, md)}
                    />
                ) : null}
            </DOMDProvider>
        </div>
    );
}
