"use client";
import { useEffect } from "react";
import { useEditorDom } from "@do-md/core-react";

/**
 * Put real DOM focus on the editor when a tab switch mounts this view.
 *
 * Selecting a tab means "I want to work in this document", and it has to be
 * DOM focus specifically: the kernel binds undo/redo and the rest of its key
 * handling to the editable root, not to window, so a document that is focused
 * only in the model is one where ⌘Z silently does nothing.
 *
 * `store.focus()` is not enough on its own here. It records focus INTENT and
 * the render layer materializes it, which is the right call for gestures
 * mid-session — but across a view remount (which is what a tab switch is) the
 * intent can land without the new editable root ever taking browser focus.
 * Observed directly: after a switch `document.activeElement` was the editor
 * root and `store.focused_` was true, a synthetic keydown dispatched at that
 * root undid correctly, and yet real keystrokes did nothing until something
 * called `.focus()` on the element itself.
 *
 * The kernel deliberately never steals focus on attach — restoring it is the
 * host's call, which is exactly what this is. Mounted inside the provider so
 * it can reach the editable root through the kernel's own DOM context rather
 * than querying for a kernel-internal attribute.
 */
export function TabFocusOnSwitch({ enabled }: { enabled: boolean }) {
    const { textAreaDomRef } = useEditorDom();

    useEffect(() => {
        if (!enabled) return;
        // One frame late: the editable root mounts through a ref sink and the
        // controller attaches with it, so focusing in the same commit can beat
        // the listeners into place.
        const raf = requestAnimationFrame(() => {
            // preventScroll is load-bearing. Without it the browser
            // scroll-into-views the WHOLE contenteditable root — top edge
            // aligned, viewport yanked to the document top — one frame AFTER
            // the kernel's scroll-memory restore already positioned it, and
            // the resulting scroll event then overwrites the stored anchor
            // with "top of document", destroying the position for every
            // later switch too. Same failure mode the kernel documents in
            // EditorController.focus(); this call site bypasses the
            // controller (deliberately — its focus() carries click-gesture
            // selection semantics), so it must carry the flag itself.
            textAreaDomRef.current?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(raf);
    }, [enabled, textAreaDomRef]);

    return null;
}
