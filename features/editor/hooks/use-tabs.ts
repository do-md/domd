"use client";
/**
 * Desktop tab machinery for the editor shell.
 *
 * Everything here is about which document is open and how documents enter and
 * leave the window. The editor itself is untouched: useDocumentLoaders reads
 * the active tab, so upstream's editor tree renders the active document and a
 * tab switch is just another document swap.
 *
 * Web never calls this — one page, one document, no tab bar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@/common/lib/platform";
import { tauriCore, tauriWebviewWindow } from "@/common/lib/tauri";
import type { UnsavedChoice } from "../components/tab-close-modal";
import { useLatest } from "@/common/lib/use-latest";
import {
    blankTauriDoc,
    readTauriDoc,
    rereadTauriDoc,
} from "./use-document-loaders";
import { saveDocument } from "../lib/save-document";
import { useTabShortcuts } from "./use-tab-shortcuts";
import { useTauriEvent } from "./use-tauri-event";
import { useTabStore, useTabStoreApi } from "../stores/tab-store";

/** A tab close waiting on the user's answer. The name is captured when the
 *  prompt opens rather than read at render time, so a rename or a save landing
 *  underneath cannot change the question already on screen. */
export interface TabCloseRequest {
    tabId: string;
    name: string;
}

export function useTabs({
    enabled,
    onDocumentSwitch,
}: {
    /** Desktop only. Called unconditionally (hooks rule) and inert on web,
     *  where a window is one page holding one document. */
    enabled: boolean;
    /** Runs when the ACTIVE tab changes — the same teardown upstream does
     *  when a different document loads into the window (detachSharing). The
     *  live collaboration session belongs to the document that was showing,
     *  and only the active tab has a mounted editor to attach one to. */
    onDocumentSwitch: () => void;
}) {
    const store = useTabStoreApi();
    const tabs = useTabStore((s) => s.state.tabs);
    const activeTabId = useTabStore((s) => s.state.activeTabId);
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const onDocumentSwitchRef = useLatest(onDocumentSwitch);

    useTabShortcuts({ enabled });

    /** Mirror the editor's unsaved-changes state onto the active tab so the
     *  tab bar can badge it. Stable identity — Editor stores it in a ref. */
    const markActiveTabDirty = useCallback(
        (isDirty: boolean) => {
            const id = store.state.activeTabId;
            if (id) store.markDirty(id, isDirty);
        },
        [store],
    );

    // ── Opening documents into tabs ──────────────────────────────────────
    /** Tell Rust the requested document is now the one an `insert` would hit.
     *
     *  `open_or_reuse` clears WindowReady before routing a file to this window,
     *  because the window is about to show a different document and an
     *  immediate `insert` must not land in the previous one. Something has to
     *  re-arm it, and until tabs that was the editor remount.
     *
     *  Neither route can rely on a remount any more. Reusing the lone blank tab
     *  resets the runtime in place, precisely so view state survives; and
     *  activating a background tab is a switch Rust cannot tell apart from
     *  re-activating the tab already showing, where clearing readiness with
     *  nothing to restore it would leave the CLI waiting for a mark that never
     *  comes. So readiness is asserted by the host, from the one layer that
     *  knows the document is in place — and asserted on EVERY route, including
     *  the one where nothing changed. */
    const markReady = async () => {
        if (!isTauri()) return;
        const { invoke } = await tauriCore();
        await invoke("benchmark_mark_ready").catch(() => {});
    };

    /** Reuse the lone untouched blank tab if that is all the window has —
     *  opening a file from Finder should not leave an empty tab behind.
     *  (useTauriEvent ref-stores its handler, so this closure is always the
     *  current one without any extra indirection.) */
    const openPathInTab = async (path: string) => {
        const doc = await readTauriDoc(path);
        if (store.isOnlyBlankTab()) {
            store.replaceTabDoc(store.state.tabs[0].id, doc.meta, doc.content);
        } else {
            store.addTab(doc.meta, doc.content);
        }
        await markReady();
    };

    useTauriEvent<string>("open-file-in-tab", (path) => {
        void openPathInTab(path);
    });

    useTauriEvent<string>("activate-tab", (path) => {
        const tab = store.findTabByPath(path);
        // Mark ready even when the tab was already active: `activateTab` is a
        // no-op there, but Rust cleared readiness on the way in and this is the
        // only thing that will put it back.
        if (tab) store.activateTab(tab.id);
        void markReady();
    });

    useTauriEvent("menu-new-tab", () => {
        window.dispatchEvent(new CustomEvent("domd-new-tab"));
    });

    useTauriEvent("menu-close-tab", () => {
        window.dispatchEvent(
            new CustomEvent("domd-close-tab", {
                detail: { tabId: store.state.activeTabId },
            }),
        );
    });

    // ── The per-tab unsaved prompt ───────────────────────────────────────
    // Closing one tab among several has no native counterpart — the macOS
    // sheet speaks for a window — so this asks in-app, with the sheet's three
    // outcomes rather than the two the `ask` plugin dialog can offer.
    //
    // The close flow is async and the answer comes from a rendered component,
    // so the promise is bridged through a ref: `askUnsaved` parks the resolver
    // and shows the modal, `decideUnsaved` settles it. A ref rather than state
    // because the event handlers below read it during an event, when a state
    // value captured at render time would be stale.
    const [closeRequest, setCloseRequest] = useState<TabCloseRequest | null>(
        null,
    );
    const decideRef = useRef<((choice: UnsavedChoice) => void) | null>(null);
    const refocusRef = useRef<HTMLElement | null>(null);

    const askUnsaved = useCallback(
        (request: TabCloseRequest) =>
            new Promise<UnsavedChoice>((resolve) => {
                // Captured before the modal takes focus, so it is whatever the
                // user was actually in. Only ever given back on Cancel.
                refocusRef.current = document.activeElement as HTMLElement | null;
                decideRef.current = resolve;
                setCloseRequest(request);
            }),
        [],
    );

    /** Put the caret back where it was before the prompt.
     *
     *  Cancel ONLY, and it is not optional there: the editor stays mounted and
     *  focus is sitting on a button that is about to disappear, so the next
     *  keystroke would go to <body>. The kernel binds its key handling to the
     *  editable root, which means typing would silently do nothing until you
     *  clicked back in.
     *
     *  Save and discard skip it because both close the tab, and focus for the
     *  document that comes forward belongs to TabFocusOnSwitch, after the
     *  switch. Restoring here too would aim at the outgoing editor and race
     *  the component whose whole job this is. */
    const refocusAfterCancel = useCallback(() => {
        const previous = refocusRef.current;
        refocusRef.current = null;
        if (!previous) return;
        // After the commit that unmounts the modal, or focus lands on an
        // element that is on its way out.
        requestAnimationFrame(() => {
            if (previous.isConnected) previous.focus();
        });
    }, []);

    const decideUnsaved = useCallback((choice: UnsavedChoice) => {
        const decide = decideRef.current;
        decideRef.current = null;
        setCloseRequest(null);
        decide?.(choice);
    }, []);

    // A prompt outliving its window would leave the close flow awaiting a
    // promise nobody can settle. Cancelling is the safe resolution: it is the
    // one outcome that touches neither the document nor the disk.
    useEffect(
        () => () => {
            decideRef.current?.("cancel");
            decideRef.current = null;
        },
        [],
    );

    /** Ask about a tab whose work would otherwise be lost, and report whether
     *  the caller may proceed. False means the user cancelled.
     *
     *  Only never-saved documents qualify: a path-backed one is already on
     *  disk (autosave wrote it), so closing it silently is correct. */
    const resolveUnsaved = useCallback(
        async (tabId: string): Promise<boolean> => {
            const tab = store.state.tabs.find((tb) => tb.id === tabId);
            if (!tab || !tab.isDirty) return true;
            if (tab.meta.kind !== "tauri" || tab.meta.path) return true;

            const choice = await askUnsaved({ tabId, name: tab.meta.name });
            if (choice === "cancel") {
                refocusAfterCancel();
                return false;
            }
            refocusRef.current = null;
            if (choice === "discard") return true;

            // One path for every tab: the runtime holds the live document
            // whether or not a view is attached, so a background tab needs no
            // snapshot and the active tab needs no detour through the mounted
            // editor's save handle. saveDocument opens the picker, and a
            // cancelled picker cancels the close.
            const result = await saveDocument(tab.meta, store.contentOf(tabId));
            if (result.ok) store.updateTabMeta(tabId, result.meta);
            return result.ok;
        },
        [store, askUnsaved, refocusAfterCancel],
    );

    // ── New / close, driven by the tab bar, shortcuts and native menu ────
    useEffect(() => {
        if (!enabled) return;
        const handleNewTab = () => {
            const doc = blankTauriDoc();
            store.addTab(doc.meta, doc.content);
        };

        const handleCloseTab = (e: Event) => {
            const { tabId } = (e as CustomEvent).detail;
            if (!store.state.tabs.some((tb) => tb.id === tabId)) return;
            // One prompt at a time. ⌘W still reaches the menu while the modal
            // is up, and a second close would strand the first request's
            // resolver — the close it belongs to would then await forever.
            if (decideRef.current) return;
            void (async () => {
                // Closing the LAST tab closes the window, and that goes
                // through the ordinary close so the native save sheet stays
                // the single authority on unsaved work — it now sees every
                // tab, not just the visible one (see update_tabs).
                if (store.state.tabs.length <= 1) {
                    const { getCurrentWebviewWindow } =
                        await tauriWebviewWindow();
                    await getCurrentWebviewWindow().close();
                    return;
                }
                // Closing one tab among several has no native counterpart:
                // the sheet speaks for a window, so ask here instead.
                if (!(await resolveUnsaved(tabId))) return;
                store.closeTab(tabId);
            })();
        };

        window.addEventListener("domd-new-tab", handleNewTab);
        window.addEventListener("domd-close-tab", handleCloseTab);
        return () => {
            window.removeEventListener("domd-new-tab", handleNewTab);
            window.removeEventListener("domd-close-tab", handleCloseTab);
        };
    }, [store, enabled, resolveUnsaved]);

    // ── A tab switch is a document switch ────────────────────────────────
    // Driven off the store subscription rather than an effect on activeTabId:
    // the teardown must run once per actual switch, keying on the tab id (not
    // the doc id) so switching between two never-saved documents still
    // detaches — and it is where the state below belongs too, since a
    // subscription callback is the sanctioned place to call setState.
    //
    // `switchedTabs` drives TabFocusOnSwitch, which puts real DOM focus on the
    // editor after a switch (see that component for why model-level focus is
    // not enough). Only this layer knows a mount came from a switch rather
    // than from opening the window's first document, and the empty -> first
    // tab transition is not a switch: guarding it keeps upstream's deliberate
    // no-autofocus behaviour on first load, and stops the initial load from
    // running a pointless collaboration teardown.
    const [switchedTabs, setSwitchedTabs] = useState(false);
    useEffect(
        () =>
            store.subscribe((next, prev) => {
                if (!prev.activeTabId) return;
                if (next.activeTabId === prev.activeTabId) return;
                setSwitchedTabs(true);
                onDocumentSwitchRef.current();
            }),
        [store, onDocumentSwitchRef],
    );

    // ── External writes to BACKGROUND tabs ───────────────────────────────
    // The active tab's own DiskReconciler handles its file; this only records
    // that a dormant tab's file moved (markPathStale skips the active tab).
    useTauriEvent<string>("file-changed", (path) => {
        store.markPathStale(path);
    });

    // Consume staleness when a tab returns to the foreground. A clean tab
    // adopts the disk content wholesale; a dirty one keeps its edits and asks
    // its (now mounted) reconciler for a forced pass, which splices the
    // external delta in rather than discarding either side.
    useEffect(() => {
        if (!enabled || !activeTab?.diskStale) return;
        const tabId = activeTab.id;
        if (activeTab.isDirty) {
            store.requestReconcile(tabId);
            return;
        }
        const meta = activeTab.meta;
        if (meta.kind !== "tauri" || !meta.path) {
            store.clearDiskStale(tabId);
            return;
        }
        const path = meta.path;
        let cancelled = false;
        void (async () => {
            const doc = await rereadTauriDoc(path);
            if (cancelled) return;
            if (!doc) {
                store.clearDiskStale(tabId);
                return;
            }
            store.replaceTabDoc(tabId, doc.meta, doc.content);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTab, store, enabled]);

    // ── Push open tab paths to Rust ──────────────────────────────────────
    // Feeds open_or_reuse (focus the window already showing a file and
    // activate its tab) and the file watcher (watch every open tab, not just
    // the window's last-assigned document).
    useEffect(() => {
        if (!enabled) return;
        const payload = tabs.map((tab) => {
            const path = tab.meta.kind === "tauri" ? tab.meta.path : null;
            const unsaveable = tab.isDirty && !path;
            return {
                path,
                isDirty: tab.isDirty,
                // Only for tabs the save sheet could be asked to review.
                // Everything else is either on disk already or has nothing to
                // lose, and shipping every document's text to Rust on every
                // keystroke would be pointless traffic.
                content: unsaveable ? store.contentOf(tab.id) : null,
            };
        });
        tauriCore().then(({ invoke }) => {
            invoke("update_tabs", { tabs: payload }).catch(() => {});
        });
    }, [tabs, enabled, store]);

    // ── The window's assigned document follows the active tab ────────────
    // Drives the window title, and the close flow: Rust lets a window close
    // silently when it has an assigned path (a saved document autosaves) and
    // shows the native "save changes?" sheet when it does not. Leaving a
    // previously-saved tab's path behind while an untitled tab is active
    // would drop unsaved work without a prompt.
    const activeMeta = activeTab?.meta;
    const activePath =
        activeMeta?.kind === "tauri" ? (activeMeta.path ?? null) : null;
    useEffect(() => {
        if (!enabled) return;
        tauriCore().then(({ invoke }) => {
            if (activePath) {
                invoke("set_window_path", { path: activePath }).catch(() => {});
            } else {
                invoke("clear_window_path").catch(() => {});
            }
        });
    }, [activePath, enabled]);

    // ── Window close is left to Rust, deliberately ───────────────────────
    // There is NO onCloseRequested listener here, and adding one is a trap.
    // Tauri's JS wrapper is:
    //
    //     await handler(evt);
    //     if (!evt.isPreventDefault()) await this.destroy();
    //
    // Registering a listener therefore moves responsibility for actually
    // destroying the window into JavaScript, while the Rust close handler
    // (lib.rs, WindowEvent::CloseRequested — the native "save changes?"
    // sheet) is still running its own flow. A handler that prevents, throws,
    // or simply never finishes leaves the window with nobody left to close
    // it: the red button stops working entirely, which is far worse than the
    // edge case such a listener would be guarding.
    //
    // So the close button behaves exactly as upstream does. The residual gap
    // is a background tab holding NEVER-SAVED work when the window closes:
    // the native sheet can only speak for the active document. Closing that
    // tab directly does prompt (see resolveUnsaved above), which is the path
    // people actually take, and saved documents are never at risk because
    // autosave and the switch-time flush have already written them.

    return { markActiveTabDirty, switchedTabs, closeRequest, decideUnsaved };
}
