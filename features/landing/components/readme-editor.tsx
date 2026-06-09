"use client";
import { useEffect, useRef, useState } from "react";
import { DOMD, DOMDProvider } from "@do-md/react";
import "@do-md/react/style.css";
import { tokenize } from "@/common/lib/prism";
import { pickByLocale } from "@/common/lib/locale";
import { useEditorStoreApi } from "@do-md/react";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";

// Streams `text` into the surrounding DOMDProvider one chunk at a time,
// mimicking an AI token stream. Must sit inside the provider so `useEditor`
// returns the live editor.
function StreamDriver({
    text,
    abortRef,
    onDone,
}: {
    text: string;
    abortRef: React.MutableRefObject<boolean>;
    onDone: () => void;
}) {
    const editorStore = useEditorStoreApi();
    const onDoneRef = useRef(onDone);

    useEffect(() => {
        if (!editorStore) return;
        let cancelled = false;

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const rand = (a: number, b: number) => a + Math.random() * (b - a);
        const aborted = () => cancelled || abortRef.current;

        (async () => {
            if (aborted()) return;
            // Seed: empty doc has no cursor, so plain insertText would be a
            // no-op. resetMD parses an initial slice, then focus() puts the
            // caret at end-of-doc so aiInsertInCursor has somewhere to land.
            const firstSize = 180 + Math.floor(Math.random() * 60); // 180..239
            editorStore.resetMD(text.slice(0, firstSize));
            let i = firstSize;

            while (i < text.length) {
                if (aborted()) return;
                // Split the inter-chunk wait into ~10ms slices so a tap can
                // halt insertions within one slice. A single 60–90ms sleep
                // would let one more insertText slip through after abort and
                // mutate the DOM during the pointerdown→click window, which
                // iOS reads as instability and cancels the click.
                const target = rand(55, 85);
                let waited = 0;
                while (waited < target) {
                    if (aborted()) return;
                    const step = Math.min(target - waited, 10);
                    await sleep(step);
                    waited += step;
                }
                if (aborted()) return;
                const size = 50 + Math.floor(Math.random() * 15); // 50..64
                editorStore.insertText(text.slice(i, i + size));
                i += size;
            }
            if (!aborted()) {
                // Defer: React 19 warns when an effect's continuation lands
                // a setState back into the same commit cycle. Bouncing
                // through a macrotask breaks that chain.
                setTimeout(() => onDoneRef.current(), 0);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [editorStore, text, abortRef]);

    return null;
}

export type ReadmeStreams = { en: string; zh: string; ja: string };

// Match browser-preferred locale to one of the three README translations.
function pickStream(streams: ReadmeStreams): string {
    return pickByLocale(streams);
}

// Transition timing between SSR content and the streaming editor.
const HOLD_MS = 300; // let the SSR'd content sit visible before we start swapping
const FADE_MS = 350; // duration of the fade-out / fade-in halves
// How long to keep the DOM stable after a tap on a nav link before flipping
// blockInput off. iOS dispatches click ~50–300ms after pointerdown; mutating
// the DOM inside that window will cancel the click.
const ABORT_RERENDER_DELAY_MS = 400;

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
    // Synchronous abort signal for the streaming loop. We flip this in the
    // pointerdown handler without calling setState, so no React render runs
    // between pointerdown and the synthesized click — iOS cancels the click
    // if the DOM mutates in that window.
    const abortRef = useRef(false);

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

    useEffect(() => {
        if (phase !== "streaming" || streamingDone) return;
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Element | null;
            if (!target?.closest("a")) return;
            // Stop the streaming loop synchronously — no setState, no render.
            abortRef.current = true;
            // Lift blockInput only after click had a chance to dispatch.
            setTimeout(() => setStreamingDone(true), ABORT_RERENDER_DELAY_MS);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () =>
            document.removeEventListener("pointerdown", onPointerDown, true);
    }, [phase, streamingDone]);

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
                    <CustomCursor />
                    <StreamDriver
                        text={streamText}
                        abortRef={abortRef}
                        onDone={() => setStreamingDone(true)}
                    />
                </DOMDProvider>
            )}
        </div>
    );
}
