"use client";
/**
 * Unsaved-work prompt for closing ONE tab among several.
 *
 * Window close and quit both go through the native macOS sheet, which speaks
 * for a window and has no per-tab counterpart — so this path has to ask
 * in-app. It keeps the sheet's SEMANTICS rather than its chrome: three
 * outcomes, Escape cancels, Enter saves, and the sheet's button order (Don't
 * Save set apart on the left, Cancel then Save on the right, Save default).
 *
 * The two-button `ask` plugin dialog it replaces had no Cancel at all, so a
 * close you triggered by accident could not be called off.
 *
 * Mount-only, like the sibling modals: the parent renders it conditionally so
 * each prompt is a fresh instance with no state to reset.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export type UnsavedChoice = "save" | "discard" | "cancel";

export function TabCloseModal({
    name,
    onChoose,
}: {
    /** Document being closed, shown in the question. */
    name: string;
    onChoose: (choice: UnsavedChoice) => void;
}) {
    const { t } = useTranslation();
    const saveRef = useRef<HTMLButtonElement>(null);

    // Focus the default button rather than binding Enter by hand: it makes
    // Enter-saves fall out of ordinary button behaviour, keeps Tab order
    // meaningful, and announces the default to assistive tech.
    //
    // Giving focus BACK is deliberately not done here. An unmount cleanup
    // cannot see which button was pressed, and only Cancel should restore it —
    // the other two close the tab, where focus belongs to TabFocusOnSwitch.
    // So the decision, and the restore, live with the caller in use-tabs.
    useEffect(() => {
        const id = requestAnimationFrame(() => saveRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onChoose("cancel");
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onChoose]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={() => onChoose("cancel")}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t("tabs.unsavedTitle")}
                onClick={(e) => e.stopPropagation()}
                className="bg-base-100 rounded-xl border border-base-content/15 shadow-xl p-6 w-96 max-w-[calc(100vw-2rem)]"
            >
                <h3 className="text-sm font-semibold mb-2">
                    {t("tabs.unsavedTitle")}
                </h3>
                <p className="text-xs text-base-content/60">
                    {t("tabs.unsavedBody", { name })}
                </p>
                <div className="flex items-center gap-2 mt-4">
                    {/* Set apart on the left, as the native sheet does — the
                        one irreversible choice should not sit inside the
                        cluster your hand is already heading for. */}
                    <button
                        type="button"
                        onClick={() => onChoose("discard")}
                        className="btn btn-sm btn-ghost mr-auto"
                    >
                        {t("tabs.unsavedDontSave")}
                    </button>
                    <button
                        type="button"
                        onClick={() => onChoose("cancel")}
                        className="btn btn-sm btn-ghost"
                    >
                        {t("tabs.unsavedCancel")}
                    </button>
                    <button
                        ref={saveRef}
                        type="button"
                        onClick={() => onChoose("save")}
                        className="btn btn-sm btn-primary"
                    >
                        {t("tabs.unsavedSave")}
                    </button>
                </div>
            </div>
        </div>
    );
}
