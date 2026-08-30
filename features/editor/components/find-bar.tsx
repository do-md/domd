"use client";

/**
 * VSCode-style find & replace widget — the thin UI over @do-md/search. All
 * engine logic (matching, navigation, replace, highlight painting) lives in
 * the package; this component renders SearchStore state and forwards actions.
 *
 * Must sit inside a DOMDProvider AND a SearchStoreProvider (the store is
 * shared with FindMenuItem — the ⋯ menu entry, the only trigger on touch
 * devices), and inside the editor's scroll container: the widget is a
 * zero-height sticky layer, so it pins to the visible top of the document
 * column and respects the column's width when the side panel squeezes it.
 * Clicks are stopped from bubbling — the scroll container interprets stray
 * clicks as "focus the editor", which would steal the find input's focus.
 *
 * Shortcut discipline (refe-81d227): the primary modifier is platform-split,
 * never metaKey||ctrlKey. `e.code` is used for letters because macOS ⌥
 * rewrites `e.key` ("ƒ" for ⌥F). ⌘F intentionally shadows the browser's
 * native find — an in-document widget replaces it wholesale (the Notion /
 * Google Docs / Obsidian convention).
 *
 *   ⌘F / Ctrl+F        open find (prefilled from the selection)
 *   ⌥⌘F / Ctrl+H       open with the replace row expanded
 *   ⌘G / F3 (+⇧)       next / previous match
 *   Enter / ⇧Enter     next / previous (find input)
 *   Enter / ⌘Enter     replace one / replace all (replace input)
 *   Esc                close, land the caret on the current match
 */

import { useEditorDom, useEditorStoreApi } from "@do-md/core-react";
import {
    bindSearchPainter,
    useSearchStore,
    useSearchStoreApi,
} from "@do-md/search";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useApplePlatform } from "@/common/hooks/use-apple-platform";

const ChevronIcon = ({ open }: { open: boolean }) => (
    <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
    >
        <path d="M6 4l4 4-4 4" />
    </svg>
);

const ArrowIcon = ({ down }: { down?: boolean }) => (
    <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-3.5 ${down ? "" : "rotate-180"}`}
    >
        <path d="M8 3v10M4 9l4 4 4-4" />
    </svg>
);

const CloseIcon = () => (
    <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="size-3.5"
    >
        <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
);

/** Codicon-style "replace": ab → glyph with a swap arrow. */
const ReplaceOneIcon = () => (
    <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        className="size-3.5"
    >
        <path d="M3.5 5.5v-2h9v2M8 3.5v6" />
        <path d="M5 12.5h6M9.2 10.7l1.8 1.8-1.8 1.8" />
    </svg>
);

const ReplaceAllIcon = () => (
    <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        className="size-3.5"
    >
        <path d="M2.5 4.5v-2h7v2M6 2.5v5" />
        <path d="M2.5 10.5h5M5.7 8.9l1.6 1.6-1.6 1.6" />
        <path d="M11.5 5.5h2v8h-8v-2" />
    </svg>
);

function ToggleButton({
    on,
    title,
    onClick,
    children,
}: {
    on: boolean;
    title: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-pressed={on}
            tabIndex={-1}
            onClick={onClick}
            className={`shrink-0 rounded px-1 h-5 min-w-5 text-[10px] leading-none font-mono grid place-items-center transition-colors ${
                on
                    ? "bg-base-content/15 text-base-content"
                    : "text-base-content/50 hover:text-base-content hover:bg-base-content/10"
            }`}
        >
            {children}
        </button>
    );
}

function IconButton({
    title,
    onClick,
    disabled,
    children,
}: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
            tabIndex={-1}
            onClick={onClick}
            className="shrink-0 rounded p-1 text-base-content/70 hover:text-base-content hover:bg-base-content/10 disabled:opacity-30 disabled:pointer-events-none"
        >
            {children}
        </button>
    );
}

export function FindBar() {
    const storeApi = useEditorStoreApi();
    const { textAreaDomRef } = useEditorDom();
    const mac = useApplePlatform();
    const { t } = useTranslation();

    const search = useSearchStoreApi();
    const findInputRef = useRef<HTMLInputElement>(null);

    const open = useSearchStore((s) => s.state.open);
    const replaceExpanded = useSearchStore((s) => s.state.replaceExpanded);
    const query = useSearchStore((s) => s.state.query);
    const replacement = useSearchStore((s) => s.state.replacement);
    const caseSensitive = useSearchStore((s) => s.state.caseSensitive);
    const wholeWord = useSearchStore((s) => s.state.wholeWord);
    const regex = useSearchStore((s) => s.state.regex);
    const usePreserveCase = useSearchStore((s) => s.state.preserveCase);
    const total = useSearchStore((s) => s.state.matches.length);
    const activeIndex = useSearchStore((s) => s.state.activeIndex);
    const queryError = useSearchStore((s) => s.state.queryError);
    const limitHit = useSearchStore((s) => s.state.limitHit);

    // Engine wiring: attach the editor store, bind the highlight painter to
    // the live editor DOM. Both dispose on unmount / store swap.
    useEffect(() => {
        if (!storeApi) return;
        return search.attach(storeApi);
    }, [search, storeApi]);

    useEffect(() => {
        const container = textAreaDomRef.current;
        if (!storeApi || !container) return;
        return bindSearchPainter(search, storeApi, container);
    }, [search, storeApi, textAreaDomRef]);

    // Focus + select the find input on every open transition. This covers
    // both entry points (shortcut and menu) — the store owns the prefill, the
    // UI owns the focus. Running in the effect (not rAF) keeps the focus
    // inside the triggering gesture's task, so touch devices raise the soft
    // keyboard.
    useEffect(() => {
        if (!open) return;
        findInputRef.current?.focus();
        findInputRef.current?.select();
    }, [open]);

    const close = () => {
        search.close();
        storeApi?.focus();
    };

    // Global shortcuts (capture: they must beat the browser's native find and
    // the editor's contentEditable handlers).
    useEffect(() => {
        // Re-triggering while already open re-selects the input — the open
        // effect only fires on transitions.
        const refocus = () => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            // F3 carries no modifier discipline — it is a dedicated key.
            if (e.key === "F3" && !e.metaKey && !e.ctrlKey && !e.altKey) {
                if (!search.state.open) return;
                e.preventDefault();
                if (e.shiftKey) search.findPrevious();
                else search.findNext();
                return;
            }
            const primary = mac ? e.metaKey : e.ctrlKey;
            const foreign = mac ? e.ctrlKey : e.metaKey;
            if (!primary || foreign) return;
            if (e.code === "KeyF" && !e.shiftKey) {
                if (mac && e.altKey) {
                    e.preventDefault();
                    search.openReplace();
                    refocus();
                    return;
                }
                if (!e.altKey) {
                    e.preventDefault();
                    search.openFind();
                    refocus();
                    return;
                }
                return;
            }
            if (!mac && e.code === "KeyH" && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                search.openReplace();
                refocus();
                return;
            }
            if (mac && e.code === "KeyG" && !e.altKey) {
                if (!search.state.open) return;
                e.preventDefault();
                if (e.shiftKey) search.findPrevious();
                else search.findNext();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [mac, search]);

    if (!open) return null;

    const count =
        total === 0
            ? queryError ?? (query ? t("editor.find.noResults") : "")
            : t("editor.find.count", {
                  current: activeIndex + 1,
                  total: limitHit ? `${total}+` : total,
              });

    return (
        // Zero-height sticky layer: pins to the top of the visible document
        // area without occupying flow; hidden in print.
        <div className="sticky top-0 z-30 h-0 print:hidden">
            <div
                className="absolute right-4 top-2 rounded-lg border border-base-content/15 bg-base-200 text-base-content shadow-lg p-1 flex items-stretch select-none"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        close();
                    }
                }}
            >
                <button
                    type="button"
                    title={t("editor.find.toggleReplace")}
                    tabIndex={-1}
                    onClick={() => search.toggleReplaceExpanded()}
                    className="shrink-0 rounded px-0.5 text-base-content/50 hover:text-base-content hover:bg-base-content/10"
                >
                    <ChevronIcon open={replaceExpanded} />
                </button>
                <div className="flex flex-col gap-1 ml-1">
                    <div className="flex items-center gap-1">
                        <div
                            className={`flex items-center gap-0.5 h-7 w-56 max-sm:w-36 px-1.5 rounded-md bg-base-100 border ${
                                queryError
                                    ? "border-error/60"
                                    : "border-base-content/15 focus-within:border-base-content/40"
                            }`}
                            title={queryError ?? undefined}
                        >
                            <input
                                ref={findInputRef}
                                value={query}
                                spellCheck={false}
                                placeholder={t("editor.find.placeholder")}
                                onChange={(e) =>
                                    search.setQuery(e.target.value)
                                }
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        if (e.shiftKey) search.findPrevious();
                                        else search.findNext();
                                    }
                                }}
                                className="min-w-0 grow bg-transparent outline-none text-xs"
                            />
                            <ToggleButton
                                on={caseSensitive}
                                title={t("editor.find.caseSensitive")}
                                onClick={() =>
                                    search.setOption(
                                        "caseSensitive",
                                        !caseSensitive,
                                    )
                                }
                            >
                                Aa
                            </ToggleButton>
                            <ToggleButton
                                on={wholeWord}
                                title={t("editor.find.wholeWord")}
                                onClick={() =>
                                    search.setOption("wholeWord", !wholeWord)
                                }
                            >
                                <span className="underline underline-offset-2">
                                    ab
                                </span>
                            </ToggleButton>
                            <ToggleButton
                                on={regex}
                                title={t("editor.find.regex")}
                                onClick={() =>
                                    search.setOption("regex", !regex)
                                }
                            >
                                .*
                            </ToggleButton>
                        </div>
                        <span
                            className={`text-[11px] min-w-16 px-0.5 whitespace-nowrap ${
                                queryError
                                    ? "text-error"
                                    : "text-base-content/50"
                            }`}
                        >
                            {count}
                        </span>
                        <IconButton
                            title={t("editor.find.previous")}
                            disabled={total === 0}
                            onClick={() => search.findPrevious()}
                        >
                            <ArrowIcon />
                        </IconButton>
                        <IconButton
                            title={t("editor.find.next")}
                            disabled={total === 0}
                            onClick={() => search.findNext()}
                        >
                            <ArrowIcon down />
                        </IconButton>
                        <IconButton
                            title={t("editor.find.close")}
                            onClick={close}
                        >
                            <CloseIcon />
                        </IconButton>
                    </div>
                    {replaceExpanded ? (
                        <div className="flex items-center gap-1">
                            <div className="flex items-center gap-0.5 h-7 w-56 max-sm:w-36 px-1.5 rounded-md bg-base-100 border border-base-content/15 focus-within:border-base-content/40">
                                <input
                                    value={replacement}
                                    spellCheck={false}
                                    placeholder={t(
                                        "editor.find.replacePlaceholder",
                                    )}
                                    onChange={(e) =>
                                        search.setReplacement(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key !== "Enter") return;
                                        e.preventDefault();
                                        const primary = mac
                                            ? e.metaKey
                                            : e.ctrlKey;
                                        if (primary) search.replaceAll();
                                        else search.replaceCurrent();
                                    }}
                                    className="min-w-0 grow bg-transparent outline-none text-xs"
                                />
                                <ToggleButton
                                    on={usePreserveCase}
                                    title={t("editor.find.preserveCase")}
                                    onClick={() =>
                                        search.setOption(
                                            "preserveCase",
                                            !usePreserveCase,
                                        )
                                    }
                                >
                                    AB
                                </ToggleButton>
                            </div>
                            <IconButton
                                title={t("editor.find.replaceOne")}
                                disabled={total === 0}
                                onClick={() => search.replaceCurrent()}
                            >
                                <ReplaceOneIcon />
                            </IconButton>
                            <IconButton
                                title={t("editor.find.replaceAll")}
                                disabled={total === 0}
                                onClick={() => search.replaceAll()}
                            >
                                <ReplaceAllIcon />
                            </IconButton>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/**
 * The ⋯ menu entry — shares the SearchStore through the provider, so it is
 * literally the same openFind() call the keyboard shortcut makes. This is
 * the only trigger on touch devices (no ⌘F there).
 */
export function FindMenuItem() {
    const search = useSearchStoreApi();
    const mac = useApplePlatform();
    const { t } = useTranslation();
    return (
        <li>
            <button
                onClick={(e) => {
                    e.currentTarget.blur();
                    search.openFind();
                }}
            >
                <span className="flex-1">{t("editor.find.menuTitle")}</span>
                <span className="text-[10px] leading-none text-base-content/35 tabular-nums">
                    {mac ? "⌘F" : "Ctrl+F"}
                </span>
            </button>
        </li>
    );
}
