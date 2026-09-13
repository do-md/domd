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
 * reconstructed on a SWITCH.
 *
 * That is why there is no `content` or `scrollTop` here: nothing is
 * serialized out on switch, so nothing can go stale and need a generation
 * counter to guard it. `docEpoch` below is not that counter — it does not
 * guard data, it identifies which DOCUMENT the tab currently holds.
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
     *  disk content, a dirty tab gets a forced reconcile pass (see
     *  DiskReconciler's `stale` prop). */
    diskStale: boolean;
    /** Which document generation this tab holds. Bumped whenever a DIFFERENT
     *  document replaces the tab's runtime (open-into-tab, File > New, disk
     *  re-read) — never on a switch. Part of the editor mount key: a new
     *  document must remount the view over a FRESH runtime, because undo
     *  history, the autosave first-tick guard and the collaboration teardown
     *  are all per-document. Resetting a runtime in place kept the previous
     *  document's undo stack alive against the new tree. */
    docEpoch: number;
}

export interface TabStoreState {
    tabs: Tab[];
    activeTabId: string;
    displayMode: "shrink" | "scroll";
}
