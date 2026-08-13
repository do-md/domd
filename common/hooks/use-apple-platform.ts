"use client";

import { useSyncExternalStore } from "react";
import { isApplePlatform } from "@/common/lib/format-shortcuts";

/** The host platform can't change mid-session, so there is nothing to
 *  subscribe to. */
const subscribeNever = () => () => {};

/** Always false during SSR. */
const serverSnapshot = () => false;

/**
 * True on Apple platforms. Drives BOTH halves of shortcut handling — which
 * modifier actually fires a command, and whether the hint reads "⌘B" or
 * "Ctrl+B" — so keep the two on this single source rather than sniffing
 * separately in each component.
 *
 * useSyncExternalStore rather than useState+useEffect: the value is read
 * during render on the client and has a defined server snapshot, so there is
 * no setState-in-effect cascade and no hydration mismatch.
 */
export function useApplePlatform(): boolean {
    return useSyncExternalStore(subscribeNever, isApplePlatform, serverSnapshot);
}
