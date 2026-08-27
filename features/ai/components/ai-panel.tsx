"use client";
/**
 * AI collaboration panel: master enable toggle, the agent roster and an
 * add/edit form (name, provider, model, standing prompt, provider API key).
 * Config is device-local (localStorage on web, ~/.domd/ai.json on desktop
 * — see ../lib/storage.ts); keys are stored per provider.
 * Mirrors the VersioningPanel aside geometry so the two panels feel like
 * one family.
 *
 * Layout-agnostic: fills whatever host it is mounted in (the editor's
 * side-panel slot — an in-flow drawer column on large screens, a DaisyUI
 * overlay drawer below lg). No fixed positioning, no top offsets.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadApiKey, saveApiKey } from "../lib/storage";
import {
    AI_PROVIDERS,
    pickAgentColor,
    type AgentConfig,
    type AiProvider,
} from "../lib/types";

const newId = () => Math.random().toString(36).slice(2, 10);

interface Draft {
    id: string | null; // null -> creating
    name: string;
    provider: AiProvider;
    model: string;
    prompt: string;
    apiKey: string;
}

const emptyDraft = (): Draft => ({
    id: null,
    name: "",
    provider: AI_PROVIDERS[0].id,
    model: AI_PROVIDERS[0].defaultModel,
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

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const startCreate = () => setDraft(emptyDraft());
    const startEdit = (agent: AgentConfig) =>
        setDraft({
            id: agent.id,
            name: agent.name,
            provider: agent.provider,
            model: agent.model,
            prompt: agent.prompt,
            apiKey: loadApiKey(agent.provider),
        });

    const saveDraft = () => {
        if (!draft || draft.name.trim().length === 0) return;
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

    const removeAgent = (id: string) =>
        onAgentsChange(agents.filter((a) => a.id !== id));

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
                                    {agent.provider} · {agent.model}
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
                                const provider = e.target
                                    .value as AiProvider;
                                const info = AI_PROVIDERS.find(
                                    (p) => p.id === provider,
                                );
                                setDraft({
                                    ...draft,
                                    provider,
                                    model:
                                        draft.id === null
                                            ? (info?.defaultModel ??
                                              draft.model)
                                            : draft.model,
                                    apiKey: loadApiKey(provider),
                                });
                            }}
                        >
                            {AI_PROVIDERS.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                        </select>
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
                                          provider: draft.provider,
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
                                disabled={draft.name.trim().length === 0}
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
