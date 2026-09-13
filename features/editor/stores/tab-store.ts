import type { EditorStore } from "@do-md/core-react";
import { nanoid } from "@do-md/utils";
import { ZenithStore, createReactStore } from "@do-md/zenith";
import type { FileMeta, Tab, TabStoreState } from "../lib/types";

/** Builds a document runtime for one tab. Supplied by the app so the kernel
 *  options (tokenizer, inline rules, beautifier, image loader, placeholder)
 *  live in one place — see EditorApp. */
export type CreateRuntime = (initMd: string) => EditorStore;

/**
 * The open documents of one window, and their live runtimes.
 *
 * This is the document source for BOTH runtimes of the app, not just the
 * tabbed one: useDocumentLoaders reads the active tab and writes through this
 * store, so the web shell is simply the case where nothing ever opens a
 * second tab. Keeping one path means upstream's editor tree stays the only
 * editor tree.
 *
 * Each tab owns an `EditorStore` for as long as the tab is open. It is
 * created when the tab opens and dropped when the tab closes — never on a
 * switch. Switching tabs remounts the VIEW over another tab's existing store,
 * so undo history, selection, focus and scroll survive (the kernel restores
 * the last three on attach), and a large document is never re-parsed just
 * because you looked at something else.
 *
 * The registry is a plain Map on the instance rather than part of `state`:
 * immer freezes state, and a frozen EditorStore would be inert. Nothing
 * renders from the map directly — components read the runtime for the active
 * tab id — so it does not need to be reactive.
 *
 * Starts EMPTY: the document is resolved in a mount effect (the static export
 * cannot know at build time whether it is opening a file, a draft or a blank
 * doc), and no tabs is exactly the "loading" view.
 */
export class TabStore extends ZenithStore<TabStoreState> {
    private readonly runtimes = new Map<string, EditorStore>();
    private readonly createRuntime: CreateRuntime;

    constructor(props: { createRuntime: CreateRuntime }) {
        super({ tabs: [], activeTabId: "", displayMode: "shrink" });
        this.createRuntime = props.createRuntime;
    }

    get activeTab(): Tab | undefined {
        return this.state.tabs.find((t) => t.id === this.state.activeTabId);
    }

    /** The live document runtime for a tab, or undefined once it is closed. */
    runtimeOf(tabId: string): EditorStore | undefined {
        return this.runtimes.get(tabId);
    }

    get activeRuntime(): EditorStore | undefined {
        return this.runtimes.get(this.state.activeTabId);
    }

    /** Current markdown of a tab, live from its runtime. Works for background
     *  tabs too — that is the point of keeping the store alive. */
    contentOf(tabId: string): string {
        return this.runtimes.get(tabId)?.toMarkdown() ?? "";
    }

    /** Load a document into the ACTIVE tab, creating the first tab if the
     *  window has none. This is the single-document path — what every
     *  useDocumentLoaders entry point does, and all the web shell ever does.
     *  Opening a document in a NEW tab is `addTab`. */
    openInActiveTab(meta: FileMeta, content: string): string {
        const current = this.activeTab;
        if (!current) return this.addTab(meta, content);
        this.replaceTabDoc(current.id, meta, content);
        return current.id;
    }

    /** Returns the id of the tab now showing this document — either a newly
     *  created one, or the existing tab it deduped into. */
    addTab(meta: FileMeta, content: string): string {
        // Dedup: if a tab with the same path is already open, activate it.
        if (meta.kind === "tauri" && meta.path) {
            const existing = this.state.tabs.find(
                (t) => t.meta.kind === "tauri" && t.meta.path === meta.path,
            );
            if (existing) {
                this.activateTab(existing.id);
                return existing.id;
            }
        }

        const id = nanoid();
        this.runtimes.set(id, this.createRuntime(content));
        this.produce((draft) => {
            draft.tabs.push({
                id,
                meta,
                isDirty: false,
                diskStale: false,
                reconcileEpoch: 0,
            });
            draft.activeTabId = id;
        });
        return id;
    }

    closeTab(tabId: string): "closed" | "last-tab" {
        const { tabs } = this.state;
        if (tabs.length <= 1) return "last-tab";

        const index = tabs.findIndex((t) => t.id === tabId);
        if (index === -1) return "closed";

        this.produce((draft) => {
            draft.tabs.splice(index, 1);
            if (draft.activeTabId === tabId) {
                // Activate neighbor: prefer right, fallback left.
                const nextIndex = Math.min(index, draft.tabs.length - 1);
                draft.activeTabId = draft.tabs[nextIndex].id;
            }
        });
        // The document runtime dies with its tab and only with its tab.
        // Dropping the reference is the whole teardown: the kernel's per-view
        // controller is torn down by the view unmount, and the store holds no
        // resources of its own.
        this.runtimes.delete(tabId);
        return "closed";
    }

    activateTab(tabId: string) {
        if (tabId === this.state.activeTabId) return;
        this.produce((draft) => {
            draft.activeTabId = tabId;
        });
    }

    reorderTab(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        this.produce((draft) => {
            const [moved] = draft.tabs.splice(fromIndex, 1);
            draft.tabs.splice(toIndex, 0, moved);
        });
    }

    updateTabMeta(tabId: string, meta: FileMeta) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) tab.meta = meta;
        });
    }

    /** Replace a tab's document — a different file loaded into this tab, or a
     *  disk re-read. The tab keeps its identity and its runtime; only the
     *  document inside the runtime is reset, so the view does not remount and
     *  the editor is never reconstructed. */
    replaceTabDoc(tabId: string, meta: FileMeta, content: string) {
        const runtime = this.runtimes.get(tabId);
        if (runtime) runtime.resetMD(content);
        else this.runtimes.set(tabId, this.createRuntime(content));
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (!tab) return;
            tab.meta = meta;
            tab.isDirty = false;
            tab.diskStale = false;
        });
    }

    markDirty(tabId: string, dirty: boolean) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) tab.isDirty = dirty;
        });
    }

    /** Flag every BACKGROUND tab bound to this path as needing a disk
     *  re-read. The active tab is skipped: its mounted DiskReconciler already
     *  handles `file-changed` for the live document. */
    markPathStale(path: string) {
        this.produce((draft) => {
            for (const tab of draft.tabs) {
                if (tab.id === draft.activeTabId) continue;
                if (tab.meta.kind === "tauri" && tab.meta.path === path) {
                    tab.diskStale = true;
                }
            }
        });
    }

    clearDiskStale(tabId: string) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (tab) tab.diskStale = false;
        });
    }

    /** Ask the tab's mounted reconciler for a forced pass, and clear the
     *  stale flag now that it has been handed off. */
    requestReconcile(tabId: string) {
        this.produce((draft) => {
            const tab = draft.tabs.find((t) => t.id === tabId);
            if (!tab) return;
            tab.reconcileEpoch += 1;
            tab.diskStale = false;
        });
    }

    setDisplayMode(mode: "shrink" | "scroll") {
        this.produce((draft) => {
            draft.displayMode = mode;
        });
    }

    findTabByPath(path: string): Tab | undefined {
        return this.state.tabs.find(
            (t) => t.meta.kind === "tauri" && t.meta.path === path,
        );
    }

    /** A lone, untouched, never-saved tab — the blank document a window opens
     *  with. Opening a file from Finder should reuse it rather than leave an
     *  empty tab behind. Content comes from the live runtime. */
    isOnlyBlankTab(): boolean {
        const { tabs } = this.state;
        if (tabs.length !== 1) return false;
        const tab = tabs[0];
        return (
            tab.meta.kind === "tauri" &&
            tab.meta.path === null &&
            !tab.isDirty &&
            this.contentOf(tab.id) === ""
        );
    }
}

export const {
    StoreProvider: TabStoreProvider,
    useStore: useTabStore,
    useStoreApi: useTabStoreApi,
} = createReactStore(TabStore);
