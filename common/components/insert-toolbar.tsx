"use client";

/**
 * Shared top-bar insert entries (macOS Notes-style): quick buttons that drop
 * a table or a checklist at the caret. Self-contained — reads the editor via
 * `useEditorStoreApi`, so it works anywhere INSIDE a `DOMDProvider`
 * (/editor's top bar, /collab's header). The desktop app has no web top bar;
 * its entries live on the native titlebar (see src-tauri/src/titlebar.rs).
 */

import { useEditorStoreApi } from "@do-md/core-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChecklistIcon, TableIcon } from "@/features/icons";
import type { EditorStoreWithInserts } from "@/common/lib/editor-store-compat";

export function InsertToolbar({ className = "" }: { className?: string }) {
    const { t } = useTranslation();
    const storeApi = useEditorStoreApi() as EditorStoreWithInserts | null;

    const insertTable = useCallback(() => {
        storeApi?.insertTable();
    }, [storeApi]);

    const insertChecklist = useCallback(() => {
        storeApi?.insertCheckList();
    }, [storeApi]);

    // Insertion targets the caret; keep the pointerdown from blurring the
    // editor first, or startCursorInfo is lost and insertTable no-ops.
    const keepFocus = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
    }, []);

    return (
        <div className={`flex items-center gap-0.5 ${className}`}>
            <button
                type="button"
                className="btn btn-xs btn-ghost btn-square text-base-content/60"
                aria-label={t("editor.insert.table")}
                title={t("editor.insert.table")}
                onPointerDown={keepFocus}
                onClick={insertTable}
            >
                {/* 1024-grid glyphs fill their canvas fuller than the old
                    24-grid ones — one size down keeps the same visual bulk. */}
                <TableIcon className="size-3.5" />
            </button>
            <button
                type="button"
                className="btn btn-xs btn-ghost btn-square text-base-content/60"
                aria-label={t("editor.insert.checklist")}
                title={t("editor.insert.checklist")}
                onPointerDown={keepFocus}
                onClick={insertChecklist}
            >
                <ChecklistIcon className="size-3.5" />
            </button>
        </div>
    );
}
