"use client";
import { useEffect, useRef } from "react";
import { useEditorStoreApi } from "@do-md/core-react";
import { SPEED_DELAY, type SpeedPreset } from "../lib/types";

export type StreamMetrics = {
    chars: number;
    chunks: number;
    elapsedMs: number;
};

type Props = {
    runId: number;
    text: string;
    minChunk: number;
    maxChunk: number;
    speed: SpeedPreset;
    onProgress: (m: StreamMetrics) => void;
    onDone: () => void;
};

function nextChunkSize(minChunk: number, maxChunk: number): number {
    const lo = Math.max(1, Math.min(minChunk, maxChunk));
    const hi = Math.max(lo, maxChunk);
    if (hi === lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function StreamDriver({
    runId,
    text,
    minChunk,
    maxChunk,
    speed,
    onProgress,
    onDone,
}: Props) {
    const store = useEditorStoreApi();
    const onProgressRef = useRef(onProgress);
    onProgressRef.current = onProgress;
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    // Read settings via refs so dragging the slider mid-stream changes the
    // behavior immediately without restarting the run.
    const minChunkRef = useRef(minChunk);
    minChunkRef.current = minChunk;
    const maxChunkRef = useRef(maxChunk);
    maxChunkRef.current = maxChunk;
    const speedRef = useRef(speed);
    speedRef.current = speed;

    useEffect(() => {
        if (!runId) return;
        if (!store) return;
        let cancelled = false;

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const rand = (a: number, b: number) => a + Math.random() * (b - a);

        (async () => {
            const start = performance.now();
            let chars = 0;
            let chunks = 0;

            // Seed: empty doc has no cursor, so insertText would no-op.
            const seedSize = Math.min(
                text.length,
                nextChunkSize(minChunkRef.current, maxChunkRef.current),
            );
            store.resetMD(text.slice(0, seedSize));
            chars += seedSize;
            chunks += 1;
            onProgressRef.current({ chars, chunks, elapsedMs: 0 });

            let i = seedSize;
            // throttle progress emits so we don't re-render on every tick
            let lastEmit = 0;
            // instant mode: yield to microtask between chunks, give the
            // browser a chance to paint every PAINT_YIELD_EVERY chunks
            const PAINT_YIELD_EVERY = 32;
            let sinceYield = 0;
            while (i < text.length) {
                if (cancelled) return;
                const [minD, maxD] = SPEED_DELAY[speedRef.current];
                if (maxD === 0) {
                    sinceYield++;
                    if (sinceYield >= PAINT_YIELD_EVERY) {
                        sinceYield = 0;
                        await sleep(0);
                    } else {
                        await Promise.resolve();
                    }
                } else {
                    sinceYield = 0;
                    await sleep(rand(minD, maxD));
                }
                if (cancelled) return;
                const size = nextChunkSize(
                    minChunkRef.current,
                    maxChunkRef.current,
                );
                const chunk = text.slice(i, i + size);
                store.insertText(chunk);
                i += chunk.length;
                chars += chunk.length;
                chunks += 1;
                const now = performance.now();
                if (now - lastEmit > 100 || i >= text.length) {
                    lastEmit = now;
                    onProgressRef.current({
                        chars,
                        chunks,
                        elapsedMs: now - start,
                    });
                }
            }
            if (!cancelled) {
                setTimeout(() => onDoneRef.current(), 0);
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId, store]);

    return null;
}
