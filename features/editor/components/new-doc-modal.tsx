"use client";
/**
 * Destructive-action confirmation for "New document": replaces the editor
 * content (and clears the local draft) and, when a collaboration room is
 * live, dissolves it for every participant.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function NewDocModal({
    collabActive,
    onClose,
    onConfirm,
}: {
    collabActive: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const { t } = useTranslation();

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={onClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="bg-base-100 rounded-xl shadow-xl p-6 w-96 max-w-[calc(100vw-2rem)]"
            >
                <h3 className="text-sm font-semibold mb-2">
                    {t("editor.newDocModal.title")}
                </h3>
                <p className="text-xs text-base-content/60 mb-1.5">
                    {t("editor.newDocModal.body")}
                </p>
                {collabActive ? (
                    <p className="text-xs text-warning mb-1.5">
                        {t("editor.newDocModal.bodyCollab")}
                    </p>
                ) : null}
                <div className="flex justify-end gap-2 mt-4">
                    <button
                        type="button"
                        onClick={onClose}
                        className="btn btn-sm btn-ghost"
                    >
                        {t("editor.newDocModal.cancel")}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="btn btn-sm btn-primary"
                    >
                        {t("editor.newDocModal.confirm")}
                    </button>
                </div>
            </div>
        </div>
    );
}
