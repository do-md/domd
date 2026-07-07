"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DOMD, DOMDProvider } from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import { pickByLocale } from "@/common/lib/locale";
import { useEditorStoreApi } from "@do-md/core-react";
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
            // no-op. resetMD parses an initial slice so subsequent insertText
            // calls have a last block to append to.
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
// How long the "nothing is saved" reassurance toast stays up after the reader
// opts into edit mode.
const TOAST_MS = 4200;

type Phase = "ssr" | "fading" | "streaming";

function PencilIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
    );
}

function XIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    );
}

export function ReadmeEditor({ streams }: { streams: ReadmeStreams }) {
    // The landing surface has two jobs that fight on one plane: *reading* the
    // README (the default — instant, passive, no caret) and *showing off* the
    // editor (a deliberate flourish). We separate them by default-mode:
    //
    //  ssr → fading → streaming: the locale README types itself in AI style
    //  into a READ-ONLY editor (editable=false; insertText is programmatic so
    //  streaming still works). When it finishes, the page just sits there as a
    //  clean reading surface — no caret, text selectable, links clickable.
    //
    //  A corner pill invites the reader to opt into editing. Clicking it
    //  remounts the editor as editable (the `editable` prop is init-only, so a
    //  fresh instance keyed "edit" is the only way to flip it) seeded with the
    //  same streamed markdown, and shows a "nothing is saved" reassurance. The
    //  edit chip carries an × to leave — which drops back to a *static* read
    //  instance (seeded, no StreamDriver) so exiting never re-runs the stream.
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>("ssr");
    const [streamText, setStreamText] = useState<string | null>(null);
    const [streamingDone, setStreamingDone] = useState(false);
    const [editMode, setEditMode] = useState(false);
    // True once the reader has entered edit mode at least once. After that,
    // read mode renders the seeded static instance instead of re-streaming.
    const [streamedOnce, setStreamedOnce] = useState(false);
    const [showToast, setShowToast] = useState(false);
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

    // Auto-dismiss the reassurance toast a few seconds after entering edit mode.
    useEffect(() => {
        if (!showToast) return;
        const id = setTimeout(() => setShowToast(false), TOAST_MS);
        return () => clearTimeout(id);
    }, [showToast]);

    const blockInput = phase === "streaming" && !streamingDone;
    const canEdit = streamText !== null && streamingDone && !editMode;

    const enterEdit = () => {
        setEditMode(true);
        setStreamedOnce(true);
        setShowToast(true);
    };

    const exitEdit = () => {
        setEditMode(false);
        setShowToast(false);
    };

    return (
        <>
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
                ) : !editMode && !streamedOnce ? (
                    // Live read mode: streams into a non-editable editor, then
                    // rests as a clean reading surface (no caret, selectable,
                    // links live). Stays mounted after the stream finishes.
                    <DOMDProvider
                        key="read-stream"
                        editable={false}
                        initMd=""
                        codeTokenizer={tokenize}
                    >
                        <DOMD />
                        <StreamDriver
                            text={streamText}
                            abortRef={abortRef}
                            onDone={() => setStreamingDone(true)}
                        />
                    </DOMDProvider>
                ) : !editMode ? (
                    // Static read mode: entered only after an edit session.
                    // Seeded with the full markdown, no StreamDriver — leaving
                    // edit mode must never replay the stream.
                    <DOMDProvider
                        key="read-static"
                        editable={false}
                        initMd={streamText}
                        codeTokenizer={tokenize}
                    >
                        <DOMD />
                    </DOMDProvider>
                ) : (
                    // Edit mode: fresh editable instance seeded with the same
                    // markdown. Keyed distinctly to force a remount (editable is
                    // read once at construction).
                    <DOMDProvider
                        key="edit"
                        editable={true}
                        initMd={streamText}
                        codeTokenizer={tokenize}
                    >
                        <DOMD />
                        <CustomCursor />
                    </DOMDProvider>
                )}
            </div>

            {canEdit && (
                <button
                    type="button"
                    onClick={enterEdit}
                    title={t("landing.editHint")}
                    aria-label={t("landing.editHint")}
                    className="btn btn-accent btn-sm gap-2 rounded-full shadow-lg fixed bottom-6 right-6 z-40"
                >
                    <PencilIcon />
                    {t("landing.editPill")}
                </button>
            )}

            {editMode && (
                <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-base-200/90 py-1.5 pl-3 pr-1.5 text-xs text-base-content/70 shadow-sm backdrop-blur">
                    <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
                    {t("landing.editingChip")}
                    <button
                        type="button"
                        onClick={exitEdit}
                        aria-label={t("landing.exitEdit")}
                        title={t("landing.exitEdit")}
                        className="btn btn-ghost btn-xs btn-circle -mr-0.5"
                    >
                        <XIcon />
                    </button>
                </div>
            )}

            {showToast && (
                <div
                    role="status"
                    className="fixed bottom-20 right-6 z-40 max-w-xs rounded-lg bg-neutral px-4 py-3 text-sm text-neutral-content shadow-lg"
                >
                    {t("landing.editHint")}
                </div>
            )}
        </>
    );
}
