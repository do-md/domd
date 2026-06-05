export type SpeedPreset =
    | "fast"
    | "normal"
    | "slow"
    | "very-slow"
    | "instant";

export type StreamStatus = "idle" | "streaming" | "done" | "stopped";

export const CHUNK_MIN_BOUND = 1;
export const CHUNK_BOUND_DEFAULT = 50; // initial upper bound — user can raise it
export const CHUNK_BOUND_HARD_MAX = 10000; // safety cap so a typo can't lock the UI
export const CHUNK_DEFAULT_MIN = 1;
export const CHUNK_DEFAULT_MAX = 5; // AI-style: 1..5

// [0, 0] is interpreted by the stream driver as "no sleep — yield only the
// minimum needed to keep the page paintable" (microtask between chunks, and
// a setTimeout(0) every PAINT_YIELD_EVERY chunks).
export const SPEED_DELAY: Record<SpeedPreset, [number, number]> = {
    fast: [8, 20],
    normal: [25, 60],
    slow: [60, 120],
    "very-slow": [120, 240],
    instant: [0, 0],
};

export const SPEED_LABEL: Record<SpeedPreset, string> = {
    fast: "Fast",
    normal: "Normal",
    slow: "Slow",
    "very-slow": "Very slow",
    instant: "Instant",
};
