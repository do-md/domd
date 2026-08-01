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
