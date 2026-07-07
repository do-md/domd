"use client";
import { useTranslation } from "react-i18next";
import { PROVIDERS, type Provider } from "../lib/types";

// Chat settings modal. Styled after the streaming playground's mobile dialog
// (daisyUI `modal` + `modal-backdrop`), but shown on every screen size and
// width-capped so it adapts on phones. Closed by default — chatting works with
// no configuration (mock mode).
export function ConfigModal({
    open,
    onClose,
    apiKey,
    onApiKeyChange,
    provider,
    onProviderChange,
    model,
    onModelChange,
}: {
    open: boolean;
    onClose: () => void;
    apiKey: string;
    onApiKeyChange: (v: string) => void;
    provider: Provider;
    onProviderChange: (p: Provider) => void;
    model: string;
    onModelChange: (m: string) => void;
}) {
    const { t } = useTranslation();
    const isMock = apiKey.trim().length === 0;

    return (
        <dialog className={`modal ${open ? "modal-open" : ""}`}>
            <div className="modal-box max-w-md w-[92%]">
                <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-base">
                        {t("chat.config.title")}
                    </h3>
                    <span
                        className={`badge badge-sm ${
                            isMock ? "badge-warning" : "badge-success"
                        }`}
                    >
                        {isMock ? t("chat.config.mockMode") : t("chat.config.live")}
                    </span>
                </div>
                <p className="text-xs text-base-content/50 mb-4">
                    {t("chat.config.desc")}
                </p>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-base-content/60">
                            {t("chat.config.apiKey")}
                        </span>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => onApiKeyChange(e.target.value)}
                            placeholder="sk-..."
                            className="input input-sm input-bordered w-full font-mono"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </label>

                    <div className="flex gap-2">
                        <label className="flex flex-col gap-1 flex-1">
                            <span className="text-xs text-base-content/60">
                                {t("chat.config.provider")}
                            </span>
                            <select
                                value={provider}
                                onChange={(e) =>
                                    onProviderChange(e.target.value as Provider)
                                }
                                className="select select-sm select-bordered w-full"
                            >
                                {PROVIDERS.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 flex-1">
                            <span className="text-xs text-base-content/60">
                                {t("chat.config.model")}
                            </span>
                            <input
                                type="text"
                                value={model}
                                onChange={(e) => onModelChange(e.target.value)}
                                className="input input-sm input-bordered w-full font-mono"
                                spellCheck={false}
                            />
                        </label>
                    </div>
                </div>

                <p className="text-[11px] text-base-content/40 mt-4">
                    {t("chat.config.keyNote")}
                </p>

                <div className="modal-action">
                    <button
                        type="button"
                        className="btn btn-sm btn-accent"
                        onClick={onClose}
                    >
                        {t("chat.config.done")}
                    </button>
                </div>
            </div>
            <form method="dialog" className="modal-backdrop" onClick={onClose}>
                <button>close</button>
            </form>
        </dialog>
    );
}
