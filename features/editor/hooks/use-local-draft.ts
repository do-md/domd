"use client";
/**
 * Web-mode local draft persistence: mirror the CURRENT document's markdown
 * into IndexedDB (600ms debounce, same cadence as desktop auto-save) so a
 * reload restores what was on screen instead of losing it.
 *
 * This intentionally tracks docs WITH a file handle too: the handle cannot
 * survive a reload anyway, and a draft frozen at the previous document would
 * resurrect stale content after switching docs (drag-dropping a new file
 * used to bring the OLD doc back on refresh).
 */
import { useEffect } from "react";
import { toMarkdown, useRenderData } from "@do-md/core-react";
import { isTauri } from "@/common/lib/platform";
import { saveDraft } from "@/features/collaboration";
import type { FileMeta } from "../lib/types";

const DRAFT_DEBOUNCE_MS = 600;

export function useLocalDraft(
    meta: FileMeta,
    renderData: ReturnType<typeof useRenderData>,
) {
    useEffect(() => {
        if (isTauri()) return;
        if (meta.kind !== "web") return;
        const timer = setTimeout(() => {
            void saveDraft(toMarkdown(renderData) ?? "", meta.name);
        }, DRAFT_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [meta, renderData]);
}
