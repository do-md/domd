"use client";
import { useEffect, useRef, useState } from "react";
import { DOMD, DOMDProvider } from "@do-md/react";
import "@do-md/react/style.css";
import { tokenize } from "@/common/lib/prism";
import { useEditorStoreApi } from "@do-md/react";

// Streams `text` into the surrounding DOMDProvider one chunk at a time,
// mimicking an AI token stream. Must sit inside the provider so `useEditor`
// returns the live editor.
function StreamDriver({ text, onDone }: { text: string; onDone: () => void }) {
    const editorStore = useEditorStoreApi();
    const onDoneRef = useRef(onDone);

    useEffect(() => {
        if (!editorStore) return;
        let cancelled = false;

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const rand = (a: number, b: number) => a + Math.random() * (b - a);

        (async () => {
            // Seed: empty doc has no cursor, so plain insertText would be a
            // no-op. resetMD parses an initial slice, then focus() puts the
            // caret at end-of-doc so aiInsertInCursor has somewhere to land.
            const firstSize = 2 + Math.floor(Math.random() * 5); // 2..6
            editorStore.resetMD(text.slice(0, firstSize));
            let i = firstSize;

            while (i < text.length) {
                if (cancelled) return;
                await sleep(rand(25, 45));
                if (cancelled) return;
                const size = 2 + Math.floor(Math.random() * 5); // 2..6
                editorStore.insertText(text.slice(i, i + size));
                i += size;
            }
            if (!cancelled) {
                // Defer: React 19 warns when an effect's continuation lands
                // a setState back into the same commit cycle. Bouncing
                // through a macrotask breaks that chain.
                setTimeout(() => onDoneRef.current(), 0);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [editorStore, text]);

    return null;
}

export type ReadmeStreams = { en: string; zh: string; ja: string };

// Match browser-preferred locale to one of the three README translations.
// Walks navigator.languages in order so a user with ["fr","zh-CN","en"] picks
// English (their primary), but ["zh-CN","en"] picks Chinese. Falls back to
// English for any locale we don't ship.
function pickStream(streams: ReadmeStreams): string {
    const langs =
        typeof navigator === "undefined"
            ? []
            : navigator.languages?.length
              ? navigator.languages
              : [navigator.language];
    for (const raw of langs) {
        const tag = (raw || "").toLowerCase();
        if (tag.startsWith("zh")) return streams.zh;
        if (tag.startsWith("ja")) return streams.ja;
        if (tag.startsWith("en")) return streams.en;
    }
    return streams.en;
}

// Transition timing between SSR content and the streaming editor.
const HOLD_MS = 300; // let the SSR'd content sit visible before we start swapping
const FADE_MS = 350; // duration of the fade-out / fade-in halves

type Phase = "ssr" | "fading" | "streaming";

export function ReadmeEditor({ streams }: { streams: ReadmeStreams }) {
    // SSR + first-client render: English README (canonical, SEO-friendly).
    //
    // Then a small choreographed transition: hold the SSR'd content briefly
    // so users perceive it, fade it out, swap to the empty interactive
    // editor, fade that back in, then start streaming the locale-matched
    // translation in AI-typing style. Streaming is locked via pointer-events
    // until it finishes; after that the editor unlocks for normal use.
    const [phase, setPhase] = useState<Phase>("ssr");
    const [streamText, setStreamText] = useState<string | null>(null);
    const [streamingDone, setStreamingDone] = useState(false);

    useEffect(() => {
        const text = pickStream(streams);
        // 1) hold the SSR content visible
        const t1 = setTimeout(() => setPhase("fading"), HOLD_MS);
        // 2) once fully faded out, swap the tree and flip back to opacity 1
        const t2 = setTimeout(() => {
            setStreamText(text);
            setPhase("streaming");
        }, HOLD_MS + FADE_MS);
        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
        };
    }, [streams]);

    const blockInput = phase === "streaming" && !streamingDone;

    return (
        <div
            suppressHydrationWarning
            style={{
                opacity: phase === "fading" ? 0 : 1,
                transition: `opacity ${FADE_MS}ms ease`,
                ...(blockInput
                    ? { pointerEvents: "none", userSelect: "none" }
                    : null),
            }}
        >
            {streamText === null ? (
                <DOMDProvider
                    editable={false}
                    initMd={streams.en}
                    codeTokenizer={tokenize}
                >
                    <DOMD />
                </DOMDProvider>
            ) : (
                <DOMDProvider
                    key="client"
                    editable={true}
                    initMd=""
                    codeTokenizer={tokenize}
                >
                    <DOMD />
                    <StreamDriver
                        text={streamText}
                        onDone={() => setStreamingDone(true)}
                    />
                </DOMDProvider>
            )}
        </div>
    );
}
