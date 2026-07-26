"use client";
/**
 * True once this component tree has hydrated on the client; false during SSR
 * and during the hydration render itself.
 *
 * Why it exists: i18n boots in DEFAULT_LOCALE so server HTML and the first
 * client render agree, and the provider switches to the OS locale in a mount
 * effect. Suspense boundaries hydrate LAZILY though — a boundary can hydrate
 * AFTER that language switch, so any translated text in its server HTML
 * (e.g. the top-bar BrandMark) would mismatch. Components with translated
 * SSR text render DEFAULT_LOCALE strings while this is false (matching the
 * server), and useSyncExternalStore re-renders them with the live locale
 * right after hydration.
 */
import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => {};

export const useHydrated = (): boolean =>
    useSyncExternalStore(
        subscribeNoop,
        () => true,
        () => false,
    );
