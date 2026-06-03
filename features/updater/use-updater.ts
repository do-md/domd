"use client";
import { useEffect, useState } from "react";
import { isTauri } from "@/common/lib/platform";
import {
    tauriDialog,
    tauriProcess,
    tauriUpdater,
    tauriWebviewWindow,
} from "@/common/lib/tauri";

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

        let unlistenFocus: (() => void) | undefined;
        let unlistenManual: (() => void) | undefined;
        let cancelled = false;

        const runCheck = async () => {
            if (process.env.NODE_ENV !== "production") return;
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

        const runManualCheck = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const [{ check }, { ask, message }] = await Promise.all([
                    tauriUpdater(),
                    tauriDialog(),
                ]);
                const update = await check();
                markChecked();
                if (!update) {
                    await message("DOMD is up to date.", {
                        title: "Check for Updates",
                        kind: "info",
                    });
                    return;
                }
                const install = await ask(
                    `A new version (v${update.version}) is available. Download and install now?`,
                    {
                        title: "Update available",
                        kind: "info",
                        okLabel: "Install",
                        cancelLabel: "Later",
                    },
                );
                if (!install || cancelled) return;
                await update.downloadAndInstall();
                if (cancelled) return;
                setReadyVersion(update.version);
                const restartNow = await ask(
                    `v${update.version} installed. Restart DOMD now?`,
                    {
                        title: "Restart required",
                        kind: "info",
                        okLabel: "Restart",
                        cancelLabel: "Later",
                    },
                );
                if (restartNow) {
                    const { relaunch } = await tauriProcess();
                    await relaunch();
                }
            } catch (e) {
                console.warn("[updater] manual check failed", e);
                try {
                    const { message } = await tauriDialog();
                    await message(
                        `Could not check for updates: ${
                            e instanceof Error ? e.message : String(e)
                        }`,
                        { title: "Update error", kind: "error" },
                    );
                } catch {
                    // dialog itself failed — nothing more we can do
                }
            } finally {
                inFlight = false;
            }
        };

        runCheck();

        (async () => {
            const { getCurrentWebviewWindow } = await tauriWebviewWindow();
            const win = getCurrentWebviewWindow();
            unlistenFocus = await win.listen("tauri://focus", runCheck);
            unlistenManual = await win.listen(
                "menu-check-updates",
                runManualCheck,
            );
        })();

        return () => {
            cancelled = true;
            unlistenFocus?.();
            unlistenManual?.();
        };
    }, []);

    const restart = async () => {
        const { relaunch } = await tauriProcess();
        await relaunch();
    };

    return { readyVersion, restart };
}
