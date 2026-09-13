export type FileMeta =
    | {
          kind: "tauri";
          path: string | null;
          name: string;
          /** Frontmatter `domd-id` — the document's cross-device identity.
           *  Established on open (silently injected when missing) or on the
           *  first save of a new document. */
          docId?: string | null;
          /** Raw frontmatter block (delimiters included, trailing "\n").
           *  Stripped from the editor content on load and re-prepended on
           *  every save so the kernel never sees it. */
          frontmatter?: string | null;
      }
    | {
          kind: "web";
          name: string;
          handle: FileSystemFileHandle | null;
          dirHandle?: FileSystemDirectoryHandle | null;
      };

export type View = "loading" | "editor";

/**
 * One open document.
 *
 * Deliberately holds no document CONTENT. Each tab owns a long-lived
 * `EditorStore` — the document runtime — which lives in the TabStore's
 * registry rather than in this state, because immer freezes state and a
 * frozen store is a broken one. The runtime is the source of truth for
 * content, undo history, selection, focus and scroll; a view attaches to it
 * when the tab is active and detaches when it is not, and neither side is
 * reconstructed in the process.
 *
 * That is why there is no `content`, `scrollTop` or `docEpoch` here: nothing
 * is serialized out on switch, so nothing can go stale and need a generation
 * counter to guard it.
 */
export interface Tab {
    id: string;
    meta: FileMeta;
    /** Unsaved-changes state, mirrored from the runtime while the tab is
     *  active. A background tab keeps its last-known value, which is correct
     *  while nothing edits background documents — and is what the window
     *  close flow reports to Rust for tabs that are not on screen. */
    isDirty: boolean;
    /** Set when the file watcher reported an external write while this tab
     *  was not the active one. Consumed on activation: a clean tab adopts the
     *  disk content, a dirty tab gets a forced reconcile pass. */
    diskStale: boolean;
    /** Bumped to force the mounted DiskReconciler to run a pass — reuses the
     *  same trigger mechanism as the collab attach. */
    reconcileEpoch: number;
}

export interface TabStoreState {
    tabs: Tab[];
    activeTabId: string;
    displayMode: "shrink" | "scroll";
}
