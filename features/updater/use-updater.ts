"use client";
import { useEffect, useState } from "react";
import { isTauri } from "@/common/lib/platform";
import { tauriProcess, tauriUpdater } from "@/common/lib/tauri";
import { tauriWebviewWindow } from "@/common/lib/tauri";

const LAST_CHECK_KEY = "domd:updater:last-check";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function shouldCheck(): boolean {
    try {
        const last = parseInt(localStorage.getItem(LAST_CHECK_KEY) || "0", 10);
        return Date.now() - last > CHECK_INTERVAL_MS;
    } catch {
        return true;
    }
}

function markChecked(): void {
    try {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch {
        // localStorage unavailable — fine, we'll just check again next focus.
    }
}

// Per-window guard against re-entry while a download/install is in flight.
let inFlight = false;

export type UpdaterState = {
    readyVersion: string | null;
    restart: () => Promise<void>;
};

export function useUpdater(): UpdaterState {
    const [readyVersion, setReadyVersion] = useState<string | null>(null);

    useEffect(() => {
        if (!isTauri()) return;
        if (process.env.NODE_ENV !== "production") return;

        let unlistenFocus: (() => void) | undefined;
        let cancelled = false;

        const runCheck = async () => {
            if (inFlight || !shouldCheck()) return;
            inFlight = true;
            try {
                const { check } = await tauriUpdater();
                const update = await check();
                markChecked();
                if (!update || cancelled) return;
                await update.downloadAndInstall();
                if (!cancelled) setReadyVersion(update.version);
            } catch (e) {
                console.warn("[updater] check/install failed", e);
            } finally {
                inFlight = false;
            }
        };

        runCheck();

        (async () => {
            const { getCurrentWebviewWindow } = await tauriWebviewWindow();
            const win = getCurrentWebviewWindow();
            unlistenFocus = await win.listen("tauri://focus", runCheck);
        })();

        return () => {
            cancelled = true;
            unlistenFocus?.();
        };
    }, []);

    const restart = async () => {
        const { relaunch } = await tauriProcess();
        await relaunch();
    };

    return { readyVersion, restart };
}
