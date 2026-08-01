"use client";
/**
 * Disk <-> editor reconciler (Tauri only). Two triggers, one routine:
 *
 *  1. `file-changed` events from the Rust file watcher: another program
 *     wrote the open file. Read it back, discard our own autosave echoes
 *     (see disk-sync.ts), then splice the external delta into the live
 *     document via the kernel's batch replace primitive.
 *  2. Collab-session resume (`collabEpoch` bumps after the realtime attach
 *     flushes the shared Y.Doc over the editor): the disk file may have
 *     been edited while the app was closed — calibrate once so those edits
 *     join the shared document instead of being overwritten by autosave.
 *
 * Why no editing lock: after the async file read, everything — current
 * snapshot, diff, replaceRanges — runs in ONE synchronous JS task, so user
 * input can never interleave with the calibration. The kernel maintains the
 * cursor through the replace (same machinery as a selection edit), and the
 * whole pass is millisecond-scale on normal documents.
 *
 * The replace goes through the normal edit pipeline, so collab ops, undo
 * and authorship stay consistent for free; autosave then writes the merged
 * state back to disk.
 */
import { useCallback, useEffect } from "react";
import { useEditorStoreApi } from "@do-md/core-react";
import { tauriCore } from "@/common/lib/tauri";
import { useLatest } from "@/common/lib/use-latest";
import { useTauriEvent } from "../hooks/use-tauri-event";
import { canonicalizeMd, setScratchStore } from "../lib/canonical-md";
import { isKnownDiskContent, markKnownDiskContent } from "../lib/disk-sync";
import { splitFrontmatter } from "../lib/frontmatter";
import { computeRangeEdits } from "../lib/md-diff";
import type { FileMeta } from "../lib/types";

/** Mounted inside the hidden scratch DOMDProvider (a SIBLING of the main
 *  editor provider, store only — no <DOMD/> surface): registers its store
 *  with canonical-md so external markdown can be parse->serialize
 *  normalized without touching the live document. Renders nothing. */
export function ScratchStoreBinder() {
    const store = useEditorStoreApi();
    useEffect(() => {
        setScratchStore(store);
        return () => setScratchStore(null);
    }, [store]);
    return null;
}

export function DiskReconciler({
    meta,
    onMetaUpdate,
    collabEpoch,
}: {
    meta: FileMeta;
    onMetaUpdate: (meta: FileMeta) => void;
    /** Bumped once per successful collab attach (0 = no session). */
    collabEpoch: number;
}) {
    const store = useEditorStoreApi();
    const metaRef = useLatest(meta);
    const storeRef = useLatest(store);
    const onMetaUpdateRef = useLatest(onMetaUpdate);

    /** `force` bypasses the known-disk-content shortcut. The shortcut only
     *  answers "have we already processed this disk state?" — correct for
     *  watcher echo events, WRONG for the open-time calibration: right
     *  after a collab resume the loader has just registered the disk
     *  content as known while the Y.Doc flush made the EDITOR diverge from
     *  it. Skipping there would drop external edits made while the app was
     *  closed (autosave would then overwrite them on disk). The real guard
     *  for a forced pass is the content comparison below. */
    const reconcile = useCallback(async (force: boolean) => {
        const openMeta = metaRef.current;
        if (openMeta.kind !== "tauri" || !openMeta.path) return;
        const path = openMeta.path;
        const { invoke } = await tauriCore();
        const raw = await invoke<string>("read_file", { path }).catch(
            () => null,
        );
        if (raw === null) return;
        if (!force && isKnownDiskContent(path, raw)) return;
        // Freshest ground truth for this path — lets the autosave that
        // follows the reconcile skip its (byte-identical) write instead of
        // bumping mtime and tripping other editors' conflict detection.
        markKnownDiskContent(path, raw);
        const liveStore = storeRef.current;
        if (liveStore === null) return;
        // The document may have switched while the read was in flight.
        const nowMeta = metaRef.current;
        if (nowMeta.kind !== "tauri" || nowMeta.path !== path) return;

        const { prefix, body, id } = splitFrontmatter(raw);
        // Adopt externally-edited frontmatter (new keys etc.) so our next
        // save preserves it — but only while the identity is unchanged.
        // An id change/removal is the copy/fork edge case; keep our block
        // (the next save self-heals the file).
        if (
            prefix !== null &&
            prefix !== nowMeta.frontmatter &&
            id === nowMeta.docId
        ) {
            onMetaUpdateRef.current({ ...nowMeta, frontmatter: prefix });
        }

        // From here on everything is synchronous — snapshot, diff and apply
        // land in the same JS task, so no user edit can slip in between.
        const external = canonicalizeMd(body);
        // Scratch store not mounted yet — retry on the next trigger.
        if (external === null) return;
        const current = liveStore.toMarkdown() ?? "";
        if (external === current) return;
        const edits = computeRangeEdits(current, external);
        if (edits.length === 0) return;
        liveStore.replaceRanges(...edits);
    }, [metaRef, storeRef, onMetaUpdateRef]);

    // Trigger 1: external write detected by the Rust watcher — the echo
    // shortcut applies (our own autosaves must not loop).
    useTauriEvent<string>("file-changed", (path) => {
        const current = metaRef.current;
        if (current.kind === "tauri" && current.path === path) {
            void reconcile(false);
        }
    });

    // Trigger 2: open-time calibration after a collab session attaches —
    // forced, because the loader has already registered the disk content
    // while the Y.Doc flush just replaced the editor state.
    useEffect(() => {
        if (collabEpoch > 0) void reconcile(true);
    }, [collabEpoch, reconcile]);

    return null;
}
