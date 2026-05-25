"use client";
import { useEffect, useRef } from "react";

// Stable ref to the latest value of `value`. Use to read fresh callbacks /
// state inside event listeners and effects without adding them to deps.
export function useLatest<T>(value: T) {
    const ref = useRef(value);
    useEffect(() => {
        ref.current = value;
    }, [value]);
    return ref;
}
