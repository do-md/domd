"use client";
import { useEffect } from "react";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";
import { useTabStoreApi } from "../stores/tab-store";

/**
 * Tab navigation: ⌘⇧[ / ⌘⇧] (Ctrl+Shift on other platforms).
 *
 * Deliberately nothing else. ⌘N and ⌘W are native menu accelerators, so Rust
 * already emits `menu-new-tab` / `menu-close-tab` and handling them here too
 * would fire twice wherever the key also reaches the webview. ⌘1–⌘9 and ⌘T
 * belong to the heading and table commands in `@do-md/commands`; both keymaps
 * listen on window during bubble, so a second claimant would be resolved by
 * mount order rather than by any rule.
 *
 * Matches on `event.code`, not `event.key`: with Shift held, the bracket keys
 * report "{" and "}", so keying off `event.key === "["` never fires.
 */
export function useTabShortcuts({ enabled }: { enabled: boolean }) {
    const store = useTabStoreApi();
    const isApple = useApplePlatform();

    useEffect(() => {
        if (!enabled) return;
        const handler = (e: KeyboardEvent) => {
            const modifier = isApple ? e.metaKey : e.ctrlKey;
            if (!modifier || !e.shiftKey) return;

            const forward = e.code === "BracketRight";
            const back = e.code === "BracketLeft";
            if (!forward && !back) return;

            const { tabs, activeTabId } = store.state;
            if (tabs.length < 2) return;
            const index = tabs.findIndex((tab) => tab.id === activeTabId);
            if (index === -1) return;

            e.preventDefault();
            const next = forward
                ? (index + 1) % tabs.length
                : (index - 1 + tabs.length) % tabs.length;
            store.activateTab(tabs[next].id);
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [store, enabled, isApple]);
}
