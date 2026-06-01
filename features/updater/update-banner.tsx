"use client";
import { useSearchParams } from "next/navigation";
import { useUpdater } from "./use-updater";

export function UpdateBanner() {
    const { readyVersion, restart } = useUpdater();
    // TEMP review hook: `?previewUpdate=0.2.0` forces the banner to render.
    const preview = useSearchParams().get("previewUpdate");
    const version = readyVersion ?? preview;

    if (!version) return null;

    return (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg bg-base-200 px-4 py-2 shadow-lg border border-base-300">
            <span className="text-sm">v{version} ready</span>
            <button
                className="btn btn-sm btn-accent"
                onClick={() => {
                    void restart();
                }}
            >
                Restart
            </button>
        </div>
    );
}
