/**
 * Known-disk-content registry — one map serving two purposes:
 *
 *  1. Echo guard: the Rust watcher emits `file-changed` for every mtime
 *     change, including DoMD's own saves. A disk read matching the
 *     registered content is not an external edit.
 *  2. No-op write suppression: autosave skips the write entirely when the
 *     content it would produce is byte-identical to what is known to be on
 *     disk. This matters for OTHER editors: after a reconcile pulls a
 *     Typora/VSCode edit into DoMD, the editor state usually equals the
 *     disk file exactly — writing it back anyway would bump mtime and make
 *     Typora's NSDocument flag "changed by another application" on its next
 *     save. No write, no conflict sheet.
 *
 * The registry is updated by every DoMD write (registered BEFORE the write
 * so an early watcher event still matches) and by every disk read the
 * reconciler performs (the freshest ground truth).
 */

const knownDiskContent = new Map<string, string>();

/** Register the full file content that is (about to be) on disk at `path`. */
export const markKnownDiskContent = (path: string, content: string): void => {
    knownDiskContent.set(path, content);
};

/** True when `content` matches the registered on-disk content for `path`. */
export const isKnownDiskContent = (path: string, content: string): boolean =>
    knownDiskContent.get(path) === content;
