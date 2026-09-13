"use client";
/**
 * AI collaboration panel: master enable toggle, the agent roster and an
 * add/edit form (name, provider, model, standing prompt, provider API key).
 * Config is device-local (localStorage on web, ~/.domd/ai.json on desktop
 * — see ../lib/storage.ts); keys are stored per provider.
 *
 * Besides the built-in presets, the provider picker can create a custom
 * OpenAI-compatible endpoint (a reverse proxy, DeepSeek, a local server):
 * the base URL lives in the provider entry, so several agents can share one
 * endpoint and its key, and deleting the last agent that uses a custom
 * endpoint takes the endpoint and its key with it.
 * Mirrors the VersioningPanel aside geometry so the two panels feel like
 * one family.
 *
 * Layout-agnostic: fills whatever host it is mounted in (the editor's
 * side-panel slot — an in-flow drawer column on large screens, a DaisyUI
 * overlay drawer below lg). No fixed positioning, no top offsets.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    loadApiKey,
    loadProviders,
    providerLabel,
    removeProvider,
    saveApiKey,
    upsertProvider,
} from "../lib/storage";
import {
    BUILTIN_PROVIDERS,
    isCustomProvider,
    newCustomProviderId,
    pickAgentColor,
    type AgentConfig,
    type AiProvider,
} from "../lib/types";

const newId = () => Math.random().toString(36).slice(2, 10);

/** Sentinel <option> that turns the picker into "define a new endpoint". */
const NEW_CUSTOM = "__new_custom__";

interface Draft {
    id: string | null; // null -> creating
    name: string;
    provider: AiProvider;
    /** Custom endpoints only: display name and base URL of the provider
     *  entry the draft creates or edits. */
    endpointLabel: string;
    baseUrl: string;
    model: string;
    prompt: string;
    apiKey: string;
}

const emptyDraft = (): Draft => ({
    id: null,
    name: "",
    provider: BUILTIN_PROVIDERS[0].id,
    endpointLabel: "",
    baseUrl: "",
    model: BUILTIN_PROVIDERS[0].defaultModel,
    prompt: "",
    apiKey: "",
});

export function AiPanel({
    agents,
    onAgentsChange,
    enabled,
    onEnabledChange,
    onClose,
}: {
    agents: AgentConfig[];
    onAgentsChange: (agents: AgentConfig[]) => void;
    enabled: boolean;
    onEnabledChange: (enabled: boolean) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<Draft | null>(null);
    // Re-read on every render: the only writer is saveDraft/removeAgent
    // below, and both close or reopen the form right after.
    const providers = loadProviders();
    // Editing a custom endpoint; "pending" until the draft is saved, in
    // which case the picker needs its own option to stay selected.
    const isCustom = draft !== null && isCustomProvider(draft.provider);
    const isPendingCustom =
        draft !== null &&
        isCustom &&
        !providers.some((p) => p.id === draft.provider);
    const draftProviderLabel =
        draft === null
            ? ""
            : isCustom
              ? draft.endpointLabel.trim() || t("ai.customEndpoint")
              : providerLabel(draft.provider);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const startCreate = () => setDraft(emptyDraft());
    const startEdit = (agent: AgentConfig) => {
        const custom = providers.find((p) => p.id === agent.provider);
        setDraft({
            id: agent.id,
            name: agent.name,
            provider: agent.provider,
            endpointLabel: custom?.label ?? "",
            baseUrl: custom?.baseUrl ?? "",
            model: agent.model,
            prompt: agent.prompt,
            apiKey: loadApiKey(agent.provider),
        });
    };

    const saveDraft = () => {
        if (!draft || draft.name.trim().length === 0) return;
        if (isCustomProvider(draft.provider)) {
            const baseUrl = draft.baseUrl.trim();
            if (!baseUrl) return;
            upsertProvider({
                id: draft.provider,
                label: draft.endpointLabel.trim() || t("ai.customEndpoint"),
                baseUrl,
            });
        }
        if (draft.apiKey.trim()) {
            saveApiKey(draft.provider, draft.apiKey.trim());
        }
        if (draft.id === null) {
            const agent: AgentConfig = {
                id: newId(),
                name: draft.name.trim(),
                provider: draft.provider,
                model: draft.model.trim() || "mock",
                prompt: draft.prompt,
                color: pickAgentColor(agents.length),
            };
            onAgentsChange([...agents, agent]);
        } else {
            onAgentsChange(
                agents.map((a) =>
                    a.id === draft.id
                        ? {
                              ...a,
                              name: draft.name.trim(),
                              provider: draft.provider,
                              model: draft.model.trim() || "mock",
                              prompt: draft.prompt,
                          }
                        : a,
                ),
            );
        }
        setDraft(null);
    };

    const removeAgent = (id: string) => {
        const gone = agents.find((a) => a.id === id);
        const rest = agents.filter((a) => a.id !== id);
        onAgentsChange(rest);
        // A custom endpoint exists only for the agents pointing at it —
        // don't leave its API key behind once the last one is gone.
        if (gone && !rest.some((a) => a.provider === gone.provider)) {
            removeProvider(gone.provider);
        }
    };

    return (
        <aside className="flex h-full w-72 max-w-[85vw] flex-col border-l border-base-content/10 bg-base-100">
            <div className="flex shrink-0 items-center gap-2 border-b border-base-300 px-3 py-2">
                <span className="text-sm font-medium">{t("ai.title")}</span>
                <span className="flex-1" />
                <button
                    className="btn btn-ghost btn-xs btn-square text-base-content/50"
                    onClick={onClose}
                    aria-label={t("common.close")}
                >
                    ✕
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        className="toggle toggle-sm"
                        checked={enabled}
                        onChange={(e) => onEnabledChange(e.target.checked)}
                    />
                    {t("ai.enable")}
                </label>
                <div className="mt-1 text-[11px] leading-snug text-base-content/40">
                    {t("ai.triggerHint")}
                </div>

                <div className="mt-4 mb-1.5 flex items-center">
                    <span className="text-xs font-medium text-base-content/60">
                        {t("ai.agents")}
                    </span>
                    <span className="flex-1" />
                    {draft === null ? (
                        <button
                            className="btn btn-ghost btn-xs text-base-content/60"
                            onClick={startCreate}
                        >
                            + {t("ai.addAgent")}
                        </button>
                    ) : null}
                </div>

                {agents.length === 0 && draft === null ? (
                    <div className="rounded-lg border border-dashed border-base-content/15 p-3 text-center text-xs text-base-content/40">
                        {t("ai.noAgents")}
                    </div>
                ) : null}

                <div className="space-y-1">
                    {agents.map((agent) => (
                        <div
                            key={agent.id}
                            className="flex items-center gap-2 rounded-lg border border-base-content/10 px-2 py-1.5"
                        >
                            <span
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: agent.color }}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">
                                    {agent.name}
                                </div>
                                <div className="truncate text-[10px] text-base-content/40">
                                    {providerLabel(agent.provider)} ·{" "}
                                    {agent.model}
                                </div>
                            </div>
                            <button
                                className="btn btn-ghost btn-xs text-base-content/50"
                                onClick={() => startEdit(agent)}
                            >
                                {t("ai.edit")}
                            </button>
                            <button
                                className="btn btn-ghost btn-xs text-error/70"
                                onClick={() => removeAgent(agent.id)}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>

                {draft !== null ? (
                    <div className="mt-3 space-y-2 rounded-xl border border-base-content/10 p-2.5">
                        <input
                            className="input input-sm input-bordered w-full"
                            placeholder={t("ai.name")}
                            value={draft.name}
                            onChange={(e) =>
                                setDraft({ ...draft, name: e.target.value })
                            }
                        />
                        <select
                            className="select select-sm select-bordered w-full"
                            value={draft.provider}
                            onChange={(e) => {
                                const picked = e.target.value;
                                if (picked === NEW_CUSTOM) {
                                    setDraft({
                                        ...draft,
                                        provider: newCustomProviderId(),
                                        endpointLabel: "",
                                        baseUrl: "",
                                        apiKey: "",
                                    });
                                    return;
                                }
                                const provider = picked as AiProvider;
                                const preset = BUILTIN_PROVIDERS.find(
                                    (p) => p.id === provider,
                                );
                                const custom = providers.find(
                                    (p) => p.id === provider,
                                );
                                setDraft({
                                    ...draft,
                                    provider,
                                    endpointLabel: custom?.label ?? "",
                                    baseUrl: custom?.baseUrl ?? "",
                                    model:
                                        draft.id === null
                                            ? (preset?.defaultModel ??
                                              draft.model)
                                            : draft.model,
                                    apiKey: loadApiKey(provider),
                                });
                            }}
                        >
                            {BUILTIN_PROVIDERS.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                            {providers.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                            {isPendingCustom ? (
                                <option value={draft.provider}>
                                    {draft.endpointLabel.trim() ||
                                        t("ai.customEndpoint")}
                                </option>
                            ) : null}
                            <option value={NEW_CUSTOM}>
                                + {t("ai.addEndpoint")}
                            </option>
                        </select>
                        {isCustom ? (
                            <>
                                <input
                                    className="input input-sm input-bordered w-full"
                                    placeholder={t("ai.endpointName")}
                                    value={draft.endpointLabel}
                                    onChange={(e) =>
                                        setDraft({
                                            ...draft,
                                            endpointLabel: e.target.value,
                                        })
                                    }
                                />
                                <input
                                    className="input input-sm input-bordered w-full"
                                    placeholder="https://api.example.com/v1"
                                    value={draft.baseUrl}
                                    onChange={(e) =>
                                        setDraft({
                                            ...draft,
                                            baseUrl: e.target.value,
                                        })
                                    }
                                />
                                <div className="text-[10px] leading-snug text-base-content/40">
                                    {t("ai.baseUrlHint")}
                                </div>
                            </>
                        ) : null}
                        <input
                            className="input input-sm input-bordered w-full"
                            placeholder={t("ai.model")}
                            value={draft.model}
                            onChange={(e) =>
                                setDraft({ ...draft, model: e.target.value })
                            }
                        />
                        <input
                            type="password"
                            className="input input-sm input-bordered w-full"
                            placeholder={
                                loadApiKey(draft.provider)
                                    ? t("ai.apiKeySet")
                                    : t("ai.apiKeyFor", {
                                          provider: draftProviderLabel,
                                      })
                            }
                            value={draft.apiKey}
                            onChange={(e) =>
                                setDraft({ ...draft, apiKey: e.target.value })
                            }
                        />
                        <textarea
                            className="textarea textarea-bordered textarea-sm w-full leading-snug"
                            rows={3}
                            placeholder={t("ai.promptPlaceholder")}
                            value={draft.prompt}
                            onChange={(e) =>
                                setDraft({ ...draft, prompt: e.target.value })
                            }
                        />
                        <div className="text-[10px] leading-snug text-base-content/40">
                            {t("ai.keyNote")}
                        </div>
                        <div className="flex justify-end gap-1.5">
                            <button
                                className="btn btn-ghost btn-xs"
                                onClick={() => setDraft(null)}
                            >
                                {t("common.cancel")}
                            </button>
                            <button
                                className="btn btn-primary btn-xs"
                                disabled={
                                    draft.name.trim().length === 0 ||
                                    (isCustom && draft.baseUrl.trim() === "")
                                }
                                onClick={saveDraft}
                            >
                                {t("common.save")}
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </aside>
    );
}
