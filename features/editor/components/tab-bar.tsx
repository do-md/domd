"use client";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore, useTabStoreApi } from "../stores/tab-store";
import { useTabDragReorder } from "../hooks/use-tab-drag-reorder";

export function TabBar() {
    const { t } = useTranslation();
    const tabs = useTabStore((s) => s.state.tabs);
    const activeTabId = useTabStore((s) => s.state.activeTabId);
    const displayMode = useTabStore((s) => s.state.displayMode);
    const store = useTabStoreApi();
    const barRef = useRef<HTMLDivElement>(null);

    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
    } | null>(null);

    const tabIds = tabs.map((t) => t.id);
    const { draggingId, onPointerDown, onPointerMove, onPointerUp } =
        useTabDragReorder(tabIds, (from, to) => store.reorderTab(from, to));

    // No useCallback: this project compiles with the React Compiler, which
    // memoizes these itself. Hand-written useCallback here defeated it (the
    // compiler bails on a component whose existing memoization it cannot
    // prove it preserves) and bought nothing.
    const requestClose = (tabId: string) => {
        window.dispatchEvent(
            new CustomEvent("domd-close-tab", { detail: { tabId } }),
        );
    };

    const handleActivate = (tabId: string) => {
        if (tabId !== activeTabId) store.activateTab(tabId);
    };

    const handleClose = (e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        requestClose(tabId);
    };

    const handleMiddleClick = (e: React.MouseEvent, tabId: string) => {
        if (e.button === 1) {
            e.preventDefault();
            requestClose(tabId);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const handleSetDisplayMode = (mode: "shrink" | "scroll") => {
        store.setDisplayMode(mode);
        setContextMenu(null);
    };

    const handleNewTab = () => {
        window.dispatchEvent(new CustomEvent("domd-new-tab"));
    };

    // A window showing one document looks exactly as it did before tabs
    // existed: no strip, no border, no reserved height. Rendering nothing
    // rather than hiding it means the flex column never allots the row.
    if (tabs.length <= 1) return null;

    return (
        <div
            ref={barRef}
            data-tab-bar
            className="shrink-0 h-9 flex items-center bg-base-200 border-b border-base-300 select-none"
            style={
                displayMode === "scroll"
                    ? { overflowX: "auto", scrollbarWidth: "none" }
                    : undefined
            }
            onContextMenu={handleContextMenu}
        >
            <div
                className={`flex items-center h-full ${
                    displayMode === "shrink" ? "flex-1 min-w-0" : ""
                }`}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                {tabs.map((tab) => (
                    <div
                        key={tab.id}
                        data-tab-id={tab.id}
                        className={`
                            group relative flex items-center gap-1 h-full px-3
                            cursor-pointer border-r border-base-300 text-xs
                            transition-colors duration-100
                            ${displayMode === "shrink" ? "flex-1 min-w-[80px] max-w-[200px]" : "min-w-[120px] max-w-[200px] shrink-0"}
                            ${tab.id === activeTabId ? "bg-base-100 text-base-content" : "bg-base-200 text-base-content/60 hover:bg-base-300/50"}
                            ${draggingId === tab.id ? "opacity-70" : ""}
                        `}
                        onClick={() => handleActivate(tab.id)}
                        onMouseDown={(e) => handleMiddleClick(e, tab.id)}
                        onPointerDown={(e) => {
                            // Don't start drag when clicking the close button
                            if ((e.target as HTMLElement).closest("button"))
                                return;
                            const bar = barRef.current;
                            if (bar) onPointerDown(e, tab.id, bar);
                        }}
                    >
                        {tab.isDirty && (
                            <span className="w-2 h-2 rounded-full bg-base-content/40 shrink-0" />
                        )}
                        <span className="truncate flex-1">{tab.meta.name}</span>
                        <button
                            className="w-4 h-4 flex items-center justify-center rounded
                                       opacity-0 group-hover:opacity-100 hover:bg-base-300
                                       transition-opacity shrink-0"
                            onClick={(e) => handleClose(e, tab.id)}
                            aria-label={t("tabs.closeTab")}
                        >
                            <svg
                                viewBox="0 0 12 12"
                                className="w-3 h-3"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M3 3l6 6M9 3l-6 6" />
                            </svg>
                        </button>
                    </div>
                ))}
            </div>

            <button
                className="shrink-0 w-7 h-7 flex items-center justify-center mx-1
                           rounded hover:bg-base-300 text-base-content/50 hover:text-base-content"
                onClick={handleNewTab}
                aria-label={t("tabs.newTab")}
            >
                <svg
                    viewBox="0 0 12 12"
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                >
                    <path d="M6 2v8M2 6h8" />
                </svg>
            </button>

            {contextMenu && (
                <>
                    <div
                        className="fixed inset-0 z-50"
                        onClick={() => setContextMenu(null)}
                    />
                    <div
                        className="fixed z-50 bg-base-100 border border-base-300 rounded-lg shadow-lg py-1 min-w-[180px]"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-base-200 flex items-center justify-between"
                            onClick={() => handleSetDisplayMode("shrink")}
                        >
                            {t("tabs.shrinkToFit")}
                            {displayMode === "shrink" && (
                                <span className="text-base-content">✓</span>
                            )}
                        </button>
                        <button
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-base-200 flex items-center justify-between"
                            onClick={() => handleSetDisplayMode("scroll")}
                        >
                            {t("tabs.scrollHorizontally")}
                            {displayMode === "scroll" && (
                                <span className="text-base-content">✓</span>
                            )}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
