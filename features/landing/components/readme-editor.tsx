"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DOMD, DOMDProvider } from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize } from "@/common/lib/prism";
import { beautify } from "@/common/lib/beautify";
import { pickByLocale } from "@/common/lib/locale";
import {
    useEditorStoreApi,
    useEditorDom,
    type EditorStoreApi,
} from "@do-md/core-react";
import { CustomCursor } from "@/plugins/rendering/CustomCursor";

// setEditable landed in @do-md/core-react 0.2.10 but isn't in the package's
// hand-maintained d.ts yet. Augment the exported store type so we can toggle
// editability in place instead of remounting a fresh provider.
declare module "@do-md/core-react" {
    interface EditorStoreApi {
        setEditable(editable: boolean): void;
    }
}

// Bridges the in-provider editor store out to a parent ref so the overlay
// controls (which live outside the provider) can call setEditable.
function StoreBridge({
    apiRef,
}: {
    apiRef: React.MutableRefObject<EditorStoreApi | null>;
}) {
    const store = useEditorStoreApi();
    useEffect(() => {
        apiRef.current = store;
        return () => {
            apiRef.current = null;
        };
    }, [store, apiRef]);
    return null;
}

// Streaming pacing. The point of the stream is the "AI typing" flourish — but
// only the part the reader can actually see is worth pacing. So the visible
// first screen types at a readable cruise speed; the moment the content grows
// past the fold (further chunks land off-screen), we ramp up — each chunk gets
// bigger and its delay shorter — so the invisible remainder finishes fast and
// the reader can start editing sooner.
const CRUISE_CHUNK_MIN = 50; // chars per chunk while visible
const CRUISE_CHUNK_MAX = 64;
const CRUISE_DELAY_MIN = 55; // ms between chunks while visible
const CRUISE_DELAY_MAX = 85;
const ACCEL_GROWTH = 1.5; // per off-screen chunk: size ×, delay ÷
const ACCEL_MAX_CHUNK = 4000; // cap so a single insert can't get pathological
// Safety net: if the editor DOM can't be measured, ramp up after this many
// chars anyway so a tall/oddly-laid-out viewport never streams slowly forever.
const FALLBACK_ACCEL_AT = 2000;

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
    const { textAreaDomRef } = useEditorDom();
    const onDoneRef = useRef(onDone);

    useEffect(() => {
        if (!editorStore) return;
        let cancelled = false;

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const rand = (a: number, b: number) => a + Math.random() * (b - a);
        const randInt = (a: number, b: number) =>
            a + Math.floor(Math.random() * (b - a + 1));
        const aborted = () => cancelled || abortRef.current;

        // True once the streamed content has filled the viewport, i.e. new
        // chunks now land below the fold where the stream isn't visible.
        const pastFold = () => {
            if (typeof window === "undefined") return false;
            const el = textAreaDomRef.current;
            if (!el) return false;
            return el.getBoundingClientRect().bottom >= window.innerHeight;
        };

        (async () => {
            if (aborted()) return;
            // Seed: empty doc has no cursor, so plain insertText would be a
            // no-op. resetMD parses an initial slice so subsequent insertText
            // calls have a last block to append to.
            const firstSize = 180 + Math.floor(Math.random() * 60); // 180..239
            editorStore.resetMD(text.slice(0, firstSize));
            let i = firstSize;

            // `accel` grows geometrically once we cross the fold, so both the
            // chunk size and the (shrinking) delay compound — faster and faster.
            let accelerating = false;
            let accel = 1;

            while (i < text.length) {
                if (aborted()) return;

                if (!accelerating && (i >= FALLBACK_ACCEL_AT || pastFold())) {
                    accelerating = true;
                }

                let size: number;
                let delay: number;
                if (accelerating) {
                    size = Math.min(
                        Math.round(CRUISE_CHUNK_MAX * accel),
                        ACCEL_MAX_CHUNK,
                    );
                    delay = CRUISE_DELAY_MIN / accel;
                    accel *= ACCEL_GROWTH;
                } else {
                    size = randInt(CRUISE_CHUNK_MIN, CRUISE_CHUNK_MAX);
                    delay = rand(CRUISE_DELAY_MIN, CRUISE_DELAY_MAX);
                }

                // Split the wait into ~10ms slices so a tap can halt insertions
                // within one slice. A single long sleep would let one more
                // insertText slip through after abort and mutate the DOM during
                // the pointerdown→click window, which iOS reads as instability
                // and cancels the click.
                let waited = 0;
                while (waited < delay) {
                    if (aborted()) return;
                    const step = Math.min(delay - waited, 10);
                    await sleep(step);
                    waited += step;
                }
                if (aborted()) return;
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
    }, [editorStore, text, abortRef, textAreaDomRef]);

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
    //  A corner pill invites the reader to opt into editing. It calls the
    //  store's setEditable(true) to flip the SAME instance editable in place —
    //  no remount, no re-seed, and any edits persist when toggling back. The
    //  edit chip carries an × that calls setEditable(false) to return to
    //  reading. A "nothing is saved" toast reassures on entry.
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>("ssr");
    const [streamText, setStreamText] = useState<string | null>(null);
    const [streamingDone, setStreamingDone] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [showToast, setShowToast] = useState(false);
    // Synchronous abort signal for the streaming loop. We flip this in the
    // pointerdown handler without calling setState, so no React render runs
    // between pointerdown and the synthesized click — iOS cancels the click
    // if the DOM mutates in that window.
    const abortRef = useRef(false);
    // Live editor store, lifted out of the provider by StoreBridge.
    const storeRef = useRef<EditorStoreApi | null>(null);

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
        storeRef.current?.setEditable(true);
        setEditMode(true);
        setShowToast(true);
    };

    const exitEdit = () => {
        storeRef.current?.setEditable(false);
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
                ) : (
                    // One persistent instance for the whole client lifetime:
                    // starts read-only, streams in, then setEditable() toggles
                    // it between reading and editing in place. CustomCursor only
                    // mounts while editing (custom caret is meaningless in read).
                    <DOMDProvider
                        key="client"
                        editable={false}
                        initMd=""
                        codeTokenizer={tokenize}
                        codeBeautify={beautify}
                    >
                        <DOMD />
                        <StoreBridge apiRef={storeRef} />
                        <StreamDriver
                            text={streamText}
                            abortRef={abortRef}
                            onDone={() => setStreamingDone(true)}
                        />
                        {editMode && <CustomCursor />}
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
