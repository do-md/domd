"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useEditorStore, useEditorStoreApi } from "@do-md/core-react";
import type { ViewportPin } from "@/plugins/shared/use-visual-viewport-pin";
import { QUICK_INPUT_KEYS } from "./keys";

const COARSE_POINTER = "(pointer: coarse)";

function subscribePointerType(onChange: () => void) {
    const mql = window.matchMedia(COARSE_POINTER);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
}

function getIsTouchSnapshot() {
    return window.matchMedia(COARSE_POINTER).matches;
}

// Dev override (`?quickbar=1`): keeps the bar permanently visible so it can
// be exercised on desktop where no software keyboard ever shows up.
const subscribeNoop = () => () => {};
function getForcedSnapshot() {
    return new URLSearchParams(window.location.search).has("quickbar");
}

/**
 * Mobile quick-input toolbar: a horizontal, scrollable row of Markdown
 * snippet keys riding on top of the software keyboard.
 *
 * Shown only while the keyboard is up (`pin` non-null, driven by
 * useVisualViewportPin in the editor layout) on touch devices. The host
 * layout pins itself to the visual viewport and sets --kb-safe-bottom to
 * 0px while the keyboard is up — the home indicator sits behind the
 * keyboard, so the safe-area inset must not be padded twice.
 */
export function QuickInputBar({ pin = null }: { pin?: ViewportPin | null }) {
    const store = useEditorStoreApi();
    const isEditable = useEditorStore((s) => s.isEditable);
    const isTouch = useSyncExternalStore(
        subscribePointerType,
        getIsTouchSnapshot,
        () => false,
    );
    const forced = useSyncExternalStore(
        subscribeNoop,
        getForcedSnapshot,
        () => false,
    );

    const show = (forced || (isTouch && pin !== null)) && isEditable;
    const pinHeight = pin?.height ?? null;

    // Stability-gated reveal: the bar stays invisible (opacity 0, but still
    // occupying flex space so the layout doesn't reflow) until the keyboard
    // geometry has stopped moving. iOS — especially on a re-open after the
    // iOS 26 rebound bug left stale vv values — can emit a burst of
    // intermediate heights while the keyboard animates; painting the bar
    // during that burst shows it ghosting through transient positions.
    // Every height change restarts the timer, so the bar fades in only
    // 120ms after the geometry went quiet. offsetTop-only changes (user
    // panning with the keyboard up) do NOT re-hide it.
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        if (!show) {
            setVisible(false);
            return;
        }
        // Forced desktop mode with no keyboard: static dock, nothing to settle.
        if (pinHeight == null) {
            setVisible(true);
            return;
        }
        setVisible(false);
        const timer = setTimeout(() => setVisible(true), 120);
        return () => clearTimeout(timer);
    }, [show, pinHeight]);

    if (!show) return null;

    return (
        <div
            className="shrink-0 flex items-center gap-0.5 overflow-x-auto border-t border-base-300 bg-base-200 px-1.5 pt-1"
            style={{
                paddingBottom:
                    "max(var(--kb-safe-bottom, env(safe-area-inset-bottom)), 0.25rem)",
                opacity: visible ? 1 : 0,
                // Fade in on reveal; vanish instantly when re-hidden so a
                // moving frame never shows mid-fade.
                transition: visible ? "opacity 120ms ease-out" : "none",
                pointerEvents: visible ? "auto" : "none",
            }}
        >
            {QUICK_INPUT_KEYS.map((key) => (
                <button
                    key={key.id}
                    type="button"
                    title={key.title}
                    aria-label={key.title}
                    // Apple Notes-sized caps: ~44x40pt tap targets, roomy
                    // 22px stroke icons / 19px glyphs. Overflow scrolls.
                    className="btn btn-ghost h-10 min-h-0 w-11 shrink-0 rounded-lg p-0 text-base-content/80"
                    // Critical: prevent the tap from stealing focus from the
                    // contenteditable — otherwise the editor blurs and the
                    // software keyboard collapses before the click lands.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() =>
                        store?.insertText(
                            key.insertText,
                            undefined,
                            key.cursorOffset,
                        )
                    }
                >
                    {key.cap}
                </button>
            ))}
        </div>
    );
}
