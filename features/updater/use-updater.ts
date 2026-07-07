"use client";
import { useEffect, useState } from "react";
import i18n from "@/common/i18n";
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
                    await message(i18n.t("updater.upToDate"), {
                        title: i18n.t("updater.checkTitle"),
                        kind: "info",
                    });
                    return;
                }
                const install = await ask(
                    i18n.t("updater.availableBody", { version: update.version }),
                    {
                        title: i18n.t("updater.availableTitle"),
                        kind: "info",
                        okLabel: i18n.t("updater.install"),
                        cancelLabel: i18n.t("updater.later"),
                    },
                );
                if (!install || cancelled) return;
                await update.downloadAndInstall();
                if (cancelled) return;
                setReadyVersion(update.version);
                const restartNow = await ask(
                    i18n.t("updater.restartBody", { version: update.version }),
                    {
                        title: i18n.t("updater.restartTitle"),
                        kind: "info",
                        okLabel: i18n.t("updater.restart"),
                        cancelLabel: i18n.t("updater.later"),
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
                        i18n.t("updater.errorBody", {
                            error: e instanceof Error ? e.message : String(e),
                        }),
                        { title: i18n.t("updater.errorTitle"), kind: "error" },
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
