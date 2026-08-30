"use client";

/**
 * Document outline (TOC) side panel — the thin UI over @do-md/toc. All
 * engine logic (model scan, op-gated rescans, scroll-spy arbitration) lives
 * in the package; this file renders TocStore state and forwards clicks.
 *
 * Two components, decoupled on purpose:
 *
 * - TocController mounts ONCE inside the editor (it needs the scroll-area
 *   ref) and wires engine + spy only while the TOC panel is actually open —
 *   a closed panel costs zero scans and zero listeners.
 * - TocPanel is the SidePanelHost occupant (editor-app resolves it like the
 *   AI / versioning panels). It renders inside the DOMDProvider tree, so it
 *   reaches the editor DOM for click-to-jump through useEditorDom.
 *
 * Interaction semantics (mainstream-outline survey):
 * - flat list indented by `depth` (nearest-shallower-predecessor nesting,
 *   so skipped levels never over-indent);
 * - click moves the caret to the heading text (Tiptap navigateToHeading
 *   semantics, via the kernel's resolveBlockOffset + setSelection) AND
 *   scrolls the heading to the container top (scroll-margin-top in
 *   globals.css provides the breathing room); caret first, so our
 *   deterministic scroll wins over any caret-replay scrolling;
 * - the scroll spy highlights the section under the reader; entries are
 *   plain text, single-line truncated with the full title as tooltip.
 */
import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useEditorDom, useEditorStoreApi } from "@do-md/core-react";
import {
    bindTocSpy,
    scrollToHeading,
    useTocStore,
    useTocStoreApi,
} from "@do-md/toc";
import {
    useSidePanelActive,
    useSidePanelApi,
} from "@/common/components/side-panel";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";

/** Display strings for the panel-toggle shortcut (VS Code's go-to-symbol
 *  mnemonic — O for outline; plain ⌘O stays the browser's file-open). */
export const TOC_TOGGLE_SHORTCUT = {
    mac: "⇧⌘O",
    other: "Ctrl+Shift+O",
} as const;

/** Platform discipline (refe-81d227): the primary modifier is platform
 *  split, a foreign primary bails, letters match on `e.code`. */
function matchTocToggleShortcut(
    event: Pick<
        KeyboardEvent,
        "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
    >,
    { mac }: { mac: boolean },
): boolean {
    const primary = mac ? event.metaKey : event.ctrlKey;
    const foreign = mac ? event.ctrlKey : event.metaKey;
    if (!primary || foreign) return false;
    return event.code === "KeyO" && event.shiftKey && !event.altKey;
}

/** Engine + spy wiring and the toggle keystroke; renders nothing. Mount
 *  inside the editor's scroll container subtree (editor.tsx) where the
 *  scroll-area ref lives. The keystroke lives here rather than in the top
 *  bar so the desktop build (no web top bar) gets it too. */
export function TocController({
    scrollAreaRef,
}: {
    scrollAreaRef: RefObject<HTMLDivElement | null>;
}) {
    const storeApi = useEditorStoreApi();
    const toc = useTocStoreApi();
    const sidePanel = useSidePanelApi();
    const mac = useApplePlatform();
    const active = useSidePanelActive() === "toc";

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (!matchTocToggleShortcut(event, { mac })) return;
            event.preventDefault();
            sidePanel.toggle("toc");
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [mac, sidePanel]);

    useEffect(() => {
        if (!active || !storeApi) return;
        return toc.attach(storeApi);
    }, [active, storeApi, toc]);

    useEffect(() => {
        if (!active) return;
        const container = scrollAreaRef.current;
        if (!container) return;
        return bindTocSpy(toc, container);
    }, [active, toc, scrollAreaRef]);

    return null;
}

export function TocPanel({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const { textAreaDomRef } = useEditorDom();
    const toc = useTocStoreApi();
    const headings = useTocStore((s) => s.state.headings);
    const activeUuid = useTocStore((s) => s.state.activeUuid);

    return (
        // border-r, not -l: the outline panel occupies the LEFT edge (its
        // separating edge faces the document on the right).
        <aside className="flex h-full w-72 max-w-[85vw] flex-col border-r border-base-content/10 bg-base-100">
            <div className="flex shrink-0 items-center gap-2 border-b border-base-300 px-3 py-2">
                <span className="text-sm font-medium">{t("toc.title")}</span>
                <span className="flex-1" />
                <button
                    className="btn btn-ghost btn-xs btn-square text-base-content/50"
                    onClick={onClose}
                    aria-label={t("common.close")}
                >
                    ✕
                </button>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto p-2">
                {headings.length === 0 ? (
                    <div className="mx-1 mt-2 rounded-lg border border-dashed border-base-content/15 p-3 text-center text-xs leading-relaxed text-base-content/40">
                        {t("toc.empty")}
                    </div>
                ) : (
                    <ul className="space-y-px">
                        {headings.map((h) => {
                            const isActive = h.uuid === activeUuid;
                            return (
                                <li key={h.uuid}>
                                    <button
                                        type="button"
                                        title={h.text || t("toc.untitled")}
                                        aria-current={
                                            isActive ? "true" : undefined
                                        }
                                        onClick={() => {
                                            // Pin the highlight on the
                                            // clicked entry — a heading near
                                            // the document end cannot reach
                                            // the container top, and honest
                                            // scroll arbitration would hand
                                            // the highlight elsewhere. The
                                            // spy releases the pin on the
                                            // first genuine user scroll.
                                            toc.pinActive(h.uuid);
                                            // Caret first (model), scroll
                                            // second (visual). The caret
                                            // replay + focus restore run in
                                            // post-render effects and can
                                            // nudge the container after our
                                            // synchronous scroll, so a
                                            // next-frame re-scroll settles
                                            // the final position (idempotent
                                            // when nothing moved).
                                            toc.moveCaretToHeading(h.uuid);
                                            const scope =
                                                textAreaDomRef.current ??
                                                document;
                                            scrollToHeading(scope, h.uuid);
                                            requestAnimationFrame(() =>
                                                scrollToHeading(scope, h.uuid),
                                            );
                                        }}
                                        className={`block w-full truncate rounded px-2 py-1 text-left text-xs leading-5 transition-colors ${
                                            isActive
                                                ? "bg-base-content/10 text-base-content"
                                                : "text-base-content/60 hover:bg-base-content/5 hover:text-base-content"
                                        }`}
                                        style={{
                                            paddingLeft: `${8 + h.depth * 14}px`,
                                        }}
                                    >
                                        {h.text || (
                                            <span className="italic text-base-content/35">
                                                {t("toc.untitled")}
                                            </span>
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </nav>
        </aside>
    );
}
