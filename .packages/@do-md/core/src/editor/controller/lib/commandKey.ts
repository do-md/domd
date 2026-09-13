function isMacPlatform() {
    return /Mac/i.test(
        // @ts-expect-error
        navigator.userAgentData?.platform ||
            navigator.platform ||
            navigator.userAgent,
    );
}

/** The platform's primary command modifier: ⌘ on macOS, Ctrl elsewhere. */
export function commandKey(e: KeyboardEvent) {
    return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

/**
 * The other platform's command modifier: Ctrl on macOS, ⌘/Win elsewhere.
 * Kernel shortcuts must not match while it is held. On macOS the Ctrl+letter
 * space belongs to the system text bindings (NSStandardKeyBindingResponding:
 * Ctrl+A = paragraph start, Ctrl+E = paragraph end, Ctrl+N/P = next/previous
 * line, ...) that WebKit — and partially Blink — implement natively; treating
 * Ctrl as "just another command key" swallows them (issue #27). Mirrors the
 * primary/foreign split used by the @do-md/commands keymap.
 */
export function foreignCommandKey(e: KeyboardEvent) {
    return isMacPlatform() ? e.ctrlKey : e.metaKey;
}
