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
import { withFrontmatter } from "../lib/frontmatter";
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

    // ── Opening documents into tabs ──────────────────────────────────────
    /** Re-arm readiness for the ONE route where no remount will do it.
     *
     *  `open_or_reuse` clears WindowReady before routing a file to this
     *  window, so an immediate CLI `insert` waits instead of landing in the
     *  previous document. Readiness is re-asserted by the code that actually
     *  BECOMES ready: the editor's own mount effect marks after its first
     *  two RAFs, once the React tree is committed and its `cli-insert`
     *  listener is bound to the new runtime. Every route that changes the
     *  document remounts the editor (tab id or docEpoch changes the mount
     *  key), so the view's mark covers them all.
     *
     *  The single exception is re-activating the tab already showing:
     *  nothing changes, nothing remounts, and the listeners that are live
     *  right now ARE the correct ones — so the host may assert immediately.
     *  Marking from the host on the OTHER routes would be wrong, not just
     *  redundant: it runs before React commits, in the window where the
     *  outgoing editor's `cli-insert` listener is still bound, which is
     *  exactly the race the readiness gate exists to close. */
    const markReady = async () => {
        if (!isTauri()) return;
        const { invoke } = await tauriCore();
        await invoke("benchmark_mark_ready").catch(() => {});
    };

    /** Route a file into this window: activate its existing tab, reuse the
     *  lone untouched blank tab (opening a file from Finder should not leave
     *  an empty tab behind), or open a new tab. Every branch that changes
     *  the document triggers a remount, whose mount effect re-arms
     *  readiness; only the nothing-changed branch marks here.
     *
     *  Shared by every "file lands on this window" route — Finder/CLI via
     *  the Rust events below, and drag-drop via the returned handle — so a
     *  window that already shows a document always gains a TAB instead of
     *  having its current document replaced.
     *  (useTauriEvent ref-stores its handler, so this closure is always the
     *  current one without any extra indirection.) */
    const openPathInTab = async (path: string) => {
        const existing = store.findTabByPath(path);
        if (existing) {
            const alreadyActive = existing.id === store.state.activeTabId;
            store.activateTab(existing.id);
            if (alreadyActive) await markReady();
            return;
        }
        const doc = await readTauriDoc(path);
        if (store.isOnlyBlankTab()) {
            store.replaceTabDoc(store.state.tabs[0].id, doc.meta, doc.content);
        } else {
            store.addTab(doc.meta, doc.content);
        }
    };

    useTauriEvent<string>("open-file-in-tab", (path) => {
        void openPathInTab(path);
    });

    useTauriEvent<string>("activate-tab", (path) => {
        // Rust routed here off its own tab registry. If this window has no
        // such tab — the registry entry was stale (e.g. a WindowFiles path
        // left behind by a closed tab) — repair by opening the file for
        // real rather than marking a document that is not here as ready.
        void openPathInTab(path);
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

    /** Settle a tab's unsaved work before it closes, and report whether the
     *  caller may proceed. False means the user cancelled (or a save the
     *  work depends on failed).
     *
     *  A dirty PATH-BACKED tab is flushed, not prompted: on desktop a saved
     *  document autosaves, and closing it is no reason to lose the tail the
     *  600ms debounce had not written yet — the debounce timer died with the
     *  view when this tab was last switched away. The runtime still holds
     *  the live text, so the flush needs no mounted editor. Only a
     *  never-saved document has a real question to ask. */
    const resolveUnsaved = useCallback(
        async (tabId: string): Promise<boolean> => {
            const tab = store.state.tabs.find((tb) => tb.id === tabId);
            if (!tab || !tab.isDirty) return true;
            if (tab.meta.kind !== "tauri") return true;
            if (tab.meta.path) {
                // Failure keeps the tab open: the work is not on disk, and
                // silently discarding it is the one wrong answer.
                const result = await saveDocument(
                    tab.meta,
                    store.contentOf(tabId),
                );
                return result.ok;
            }

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

    // ── A tab switch OR an in-tab replacement is a document switch ───────
    // Driven off the store subscription rather than an effect on activeTabId:
    // the teardown must run once per actual switch, keying on the tab id (not
    // the doc id) so switching between two never-saved documents still
    // detaches — and it is where the state below belongs too, since a
    // subscription callback is the sanctioned place to call setState.
    //
    // The docEpoch clause covers the routes that replace the ACTIVE tab's
    // document without changing tabs — reusing the lone blank tab for a
    // Finder open, File > New, Open URL. Each is the same event for the
    // document that was showing: it is going away, and its live collab
    // session must detach or the incoming file's content would be pushed
    // into the OLD document's room by the still-attached bridge. (A
    // background tab's disk re-read also bumps its docEpoch, but it is not
    // the active tab, so no clause matches — correct, since only the active
    // document ever has an attached session.)
    //
    // `switchedTabs` drives TabFocusOnSwitch, which puts real DOM focus on the
    // editor after a switch (see that component for why model-level focus is
    // not enough). Only this layer knows a mount came from a switch rather
    // than from opening the window's first document, and the empty -> first
    // tab transition is not a switch: guarding it keeps upstream's deliberate
    // no-autofocus behaviour on first load, and stops the initial load from
    // running a pointless collaboration teardown. A replacement is a load,
    // not a switch, so it detaches without claiming focus.
    const [switchedTabs, setSwitchedTabs] = useState(false);
    useEffect(
        () =>
            store.subscribe((next, prev) => {
                if (!prev.activeTabId) return;
                if (next.activeTabId !== prev.activeTabId) {
                    setSwitchedTabs(true);
                    onDocumentSwitchRef.current();
                    return;
                }
                const prevActive = prev.tabs.find(
                    (t) => t.id === prev.activeTabId,
                );
                const nextActive = next.tabs.find(
                    (t) => t.id === next.activeTabId,
                );
                if (
                    prevActive &&
                    nextActive &&
                    nextActive.docEpoch !== prevActive.docEpoch
                ) {
                    onDocumentSwitchRef.current();
                }
            }),
        [store, onDocumentSwitchRef],
    );

    // ── External writes to BACKGROUND tabs ───────────────────────────────
    // The active tab's own DiskReconciler handles its file; this only records
    // that a dormant tab's file moved (markPathStale skips the active tab).
    useTauriEvent<string>("file-changed", (path) => {
        store.markPathStale(path);
    });

    // Consume staleness when a CLEAN tab returns to the foreground: adopt
    // the disk content wholesale. A dirty tab's divergence has to be MERGED,
    // which is the mounted DiskReconciler's job — its `stale` prop (see
    // reconcileStale below) hands the flag to the component that owns the
    // forced pass, so consumption and work cannot drift apart. The previous
    // shape bumped a counter here that nothing read: the flag was cleared,
    // no reconcile ever ran, and the next autosave overwrote the external
    // edit — the exact outcome the merge exists to prevent.
    useEffect(() => {
        if (!enabled || !activeTab?.diskStale) return;
        if (activeTab.isDirty) return;
        const tabId = activeTab.id;
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

    /** The active tab needs a forced reconcile pass: its file changed on
     *  disk while it was backgrounded AND it holds unsaved edits, so the
     *  external delta must be spliced in rather than either side discarded.
     *  Consumed by the mounted DiskReconciler via `consumeReconcileStale`. */
    const reconcileStale = !!(activeTab?.diskStale && activeTab.isDirty);
    const consumeReconcileStale = useCallback(() => {
        const id = store.state.activeTabId;
        if (id) store.clearDiskStale(id);
    }, [store]);

    // ── Push open tab state to Rust ──────────────────────────────────────
    // Feeds open_or_reuse (focus the window already showing a file and
    // activate its tab), the file watcher (watch every open tab, not just
    // the window's last-assigned document), and the close/quit gates.
    //
    // Content ships for every DIRTY tab — they are exactly the tabs whose
    // text a close could be asked to preserve. A never-saved tab ships the
    // body (what the native save sheet writes to the user's chosen path); a
    // path-backed tab ships the FULL file, frontmatter reattached, because
    // Rust flushes those bytes verbatim to the tab's own path on close and
    // a body-only write would strip the document's identity block.
    const pushTabs = useCallback(() => {
        const { tabs: current, activeTabId: activeId } = store.state;
        const payload = current.map((tab) => {
            const path = tab.meta.kind === "tauri" ? tab.meta.path : null;
            let content: string | null = null;
            if (tab.isDirty && tab.meta.kind === "tauri") {
                content = path
                    ? withFrontmatter(
                          tab.meta.frontmatter ?? null,
                          store.contentOf(tab.id),
                      )
                    : store.contentOf(tab.id);
            }
            return {
                path,
                isDirty: tab.isDirty,
                isActive: tab.id === activeId,
                content,
            };
        });
        tauriCore().then(({ invoke }) => {
            invoke("update_tabs", { tabs: payload }).catch(() => {});
        });
    }, [store]);

    // Structural trigger: tab set, dirty flags, metas, and WHICH tab is
    // active (Rust overlays the active tab's sheet content with the fresher
    // WindowContents stream, so isActive must track switches).
    useEffect(() => {
        if (!enabled) return;
        pushTabs();
    }, [tabs, activeTabId, enabled, pushTabs]);

    // Freshness trigger: `tabs` identity does not change while the user
    // TYPES in an already-dirty document — markDirty(true) is a same-value
    // write, immer returns the same state, and the effect above never
    // re-runs. Without a refresh, the content Rust holds for a dirty tab
    // stays frozen at the moment the tab first turned dirty, and that
    // near-empty snapshot is what a quit-time "Save" would write to disk.
    // The editor reports dirty state every 150ms while the document
    // changes (see markActiveTabDirty), so a trailing debounce there keeps
    // the snapshot within ~750ms of the live text — and a background tab's
    // snapshot is exact, because nothing edits a background runtime.
    const dirtyPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );
    useEffect(
        () => () => {
            if (dirtyPushTimerRef.current) {
                clearTimeout(dirtyPushTimerRef.current);
            }
        },
        [],
    );

    /** Mirror the editor's unsaved-changes state onto the active tab so the
     *  tab bar can badge it — and, while dirty, keep Rust's content snapshot
     *  following the live text (see the freshness note above). Stable
     *  identity — Editor stores it in a ref. */
    const markActiveTabDirty = useCallback(
        (isDirty: boolean) => {
            const id = store.state.activeTabId;
            if (!id) return;
            store.markDirty(id, isDirty);
            if (!isDirty || !enabled) return;
            if (dirtyPushTimerRef.current) {
                clearTimeout(dirtyPushTimerRef.current);
            }
            dirtyPushTimerRef.current = setTimeout(() => {
                dirtyPushTimerRef.current = null;
                pushTabs();
            }, 600);
        },
        [store, enabled, pushTabs],
    );

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
    // So the close button behaves exactly as upstream does. Rust's close
    // flow covers every tab from the state pushed above: dirty path-backed
    // tabs are flushed to their own files (the debounced autosave a switch
    // or close would otherwise have killed), and every dirty never-saved
    // tab gets its own native save sheet before the window is destroyed.

    return {
        markActiveTabDirty,
        switchedTabs,
        closeRequest,
        decideUnsaved,
        reconcileStale,
        consumeReconcileStale,
        openPathInTab,
    };
}
