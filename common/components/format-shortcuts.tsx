"use client";

/**
 * Binds the editor's keyboard shortcuts. Renders nothing — same bridge pattern
 * as TitlebarInsertBridge, and it must sit inside a DOMDProvider to reach the
 * store.
 *
 * Mounted for BOTH runtimes on purpose: the web top bar carries the "Aa" menu,
 * the desktop build has no web top bar at all, and the shortcuts are the only
 * way to reach these commands there.
 *
 * All the arbitration — platform-correct modifier, form fields left alone,
 * no-caret/read-only pass-through, preventDefault only when a command actually
 * runs — lives in `attachKeyboardCommands`. This component supplies the two
 * things the package cannot know: which platform the hints were rendered for
 * (so key and caption agree), and which commands this app is currently
 * withholding.
 *
 * The most important job here is CLAIMING ⌘B/⌘I/⌘U. Left alone, the browser
 * services them itself on a contentEditable element via execCommand, which
 * writes <b>/<i>/<u> nodes the kernel's model knows nothing about and keeps
 * its own idea of whether the mark is on. Routing them through `format()`
 * instead makes the keystroke and the toolbar button literally the same call.
 */

import { useEditorStoreApi } from "@do-md/core-react";
import { attachKeyboardCommands } from "@do-md/commands";
import { useEffect } from "react";
import { HIDDEN_COMMANDS } from "@/common/lib/format-shortcuts";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";

export function FormatShortcuts() {
    const storeApi = useEditorStoreApi();
    const mac = useApplePlatform();

    useEffect(
        () =>
            attachKeyboardCommands(storeApi, {
                mac,
                disabled: HIDDEN_COMMANDS,
            }),
        [storeApi, mac],
    );

    return null;
}
