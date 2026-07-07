"use client";
import { useTranslation } from "react-i18next";

export function ChatIntro() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3">
            <div>
                <h1 className="text-xl font-semibold">
                    {t("chat.intro.title")}
                </h1>
                <p className="mt-1 text-sm text-base-content/60 max-w-2xl">
                    {t("chat.intro.desc")}
                </p>
            </div>
        </div>
    );
}

// Lightweight placeholder shown while the conversation is empty.
export function EmptyState({ onTryExample }: { onTryExample: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl border border-dashed border-base-300 px-5 py-6 text-sm text-base-content/60 flex flex-col gap-3 items-start">
            <div>
                <p className="font-medium text-base-content/80">
                    {t("chat.empty.tryAsking")}
                </p>
                <p className="mt-1">{t("chat.empty.example")}</p>
                <p className="mt-2 text-xs text-base-content/40">
                    {t("chat.empty.noKey")}
                </p>
            </div>
            <button
                type="button"
                onClick={onTryExample}
                className="btn btn-sm btn-neutral"
            >
                {t("chat.empty.tryExample")}
            </button>
        </div>
    );
}
