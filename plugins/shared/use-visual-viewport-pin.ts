"use client";
import { useEffect, useState } from "react";

export interface ViewportPin {
    /** Visible-area height (CSS px) while the software keyboard is up. */
    height: number;
    /** Visible-area top offset within the layout viewport. */
    top: number;
}

/**
 * Software-keyboard geometry via the VisualViewport API — the only API that
 * can sense the keyboard on iOS Safari/PWA (the VirtualKeyboard API is
 * Chromium-only and dvh/svh units don't react to the keyboard at all).
 *
 * Returns null while no keyboard is present (use the static layout), else
 * the rect to pin a fullscreen layer to so its bottom edge sits exactly on
 * the keyboard's top edge:
 *
 *   outer: fixed inset-0 (opaque)
 *     inner: absolute inset-x-0, top = pin.top, height = pin.height
 *       ... content (flex-1 min-h-0) ...
 *       toolbar (shrink-0)  <- lands on the keyboard's top edge
 *
 * Listens to BOTH `resize` and `scroll`: iOS pans the layout viewport when
 * focusing inputs near the bottom, and offsetTop changes fire only `scroll`.
 * A delayed re-read on focusout works around the iOS 26 rebound bug where
 * vv geometry doesn't restore immediately after the keyboard collapses.
 */
export function useVisualViewportPin(threshold = 40): ViewportPin | null {
    const [pin, setPin] = useState<ViewportPin | null>(null);

    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;

        const update = () => {
            // Multiply by scale so pinch-zoom (which also shrinks vv.height)
            // is not mistaken for a software keyboard.
            const keyboardUp =
                window.innerHeight - vv.height * vv.scale > threshold;
            const next = keyboardUp
                ? { height: vv.height, top: vv.offsetTop }
                : null;
            // Keep the previous object when the geometry is unchanged so
            // downstream effects (caret scrolling, reveal gating) don't
            // re-fire on every settle re-read.
            setPin((prev) =>
                prev &&
                next &&
                prev.height === next.height &&
                prev.top === next.top
                    ? prev
                    : next,
            );
        };

        // iOS 26 rebound bug: right after the keyboard collapses, vv events
        // can still report stale height/offsetTop (especially when the
        // keyboard is dismissed via its own chevron, which never blurs the
        // editor, so a focusout-based fix alone doesn't cover it). After
        // every event, re-read the geometry once more when it has settled
        // so a stale pin self-heals.
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        const onVvChange = () => {
            update();
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(update, 350);
        };

        let focusOutTimer: ReturnType<typeof setTimeout> | null = null;
        const onFocusOut = () => {
            if (focusOutTimer) clearTimeout(focusOutTimer);
            focusOutTimer = setTimeout(update, 300);
        };

        update();
        vv.addEventListener("resize", onVvChange);
        vv.addEventListener("scroll", onVvChange);
        window.addEventListener("focusout", onFocusOut, true);
        return () => {
            if (settleTimer) clearTimeout(settleTimer);
            if (focusOutTimer) clearTimeout(focusOutTimer);
            vv.removeEventListener("resize", onVvChange);
            vv.removeEventListener("scroll", onVvChange);
            window.removeEventListener("focusout", onFocusOut, true);
        };
    }, [threshold]);

    return pin;
}
