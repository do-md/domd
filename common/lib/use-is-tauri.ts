import { useSyncExternalStore } from "react";
import { isTauri } from "./platform";

const emptySubscribe = () => () => {};

/**
 * Hydration-safe `isTauri()` for RENDER-TIME branching.
 *
 * The prerendered HTML (static export / dev SSR) is built without `window`,
 * so it always contains the web layout. Branching on `isTauri()` directly
 * during render makes the desktop webview's first client render disagree
 * with that HTML — a hydration mismatch that throws the whole tree away
 * (the "Hydration failed" recoverable error in the Tauri app).
 *
 * `useSyncExternalStore` replays the server snapshot (`false`) during
 * hydration so the first client render matches the server HTML, then
 * immediately re-renders with the real value once hydration completes.
 * The platform never changes at runtime, so the subscription is inert.
 *
 * Effects, event handlers, and plain libs should keep calling `isTauri()`
 * directly — only render-time branches need this hook.
 */
export function useIsTauri(): boolean {
    return useSyncExternalStore(emptySubscribe, isTauri, () => false);
}
