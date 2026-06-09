"use client";
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
    const isMock = apiKey.trim().length === 0;

    return (
        <dialog className={`modal ${open ? "modal-open" : ""}`}>
            <div className="modal-box max-w-md w-[92%]">
                <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-base">Chat settings</h3>
                    <span
                        className={`badge badge-sm ${
                            isMock ? "badge-warning" : "badge-success"
                        }`}
                    >
                        {isMock ? "Mock mode" : "Live"}
                    </span>
                </div>
                <p className="text-xs text-base-content/50 mb-4">
                    Leave empty to use mock streaming. Add your own key to
                    stream from a real model.
                </p>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-base-content/60">
                            API key
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
                                Provider
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
                                Model
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
                    Your API key is saved in this browser (localStorage) and
                    used only here. It is never sent to DOMD servers.
                </p>

                <div className="modal-action">
                    <button
                        type="button"
                        className="btn btn-sm btn-accent"
                        onClick={onClose}
                    >
                        Done
                    </button>
                </div>
            </div>
            <form method="dialog" className="modal-backdrop" onClick={onClose}>
                <button>close</button>
            </form>
        </dialog>
    );
}
