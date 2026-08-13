/**
 * Versioning + ownership plugin: records who authored which span, keeps a
 * shared version timeline, and maintains a collaborator identity registry —
 * all inside the SAME Y.Doc the collaboration session already syncs, so the
 * data rides the existing realtime/persistence pipeline for free.
 *
 * Three side-channel structures next to the document tree (ROOT_KEY):
 *
 *   domdAuthorship:    Y.Map spanUuid -> clientId      (who wrote it)
 *   domdCollaborators: Y.Map clientId -> {name, color} (who that is)
 *   domdVersions:      Y.Array<VersionEntry>           (what changed when)
 *
 * Identity: the clientId is the ROOM identity (RoomRecord.clientId) — a
 * durable per-browser-per-room id persisted in IndexedDB — NOT the ephemeral
 * Yjs doc clientID (random per load, useless for blame). The collaborator
 * registry exists because presence (hello/cursor messages) is runtime-only:
 * once an author goes offline their name would be unresolvable. Registered
 * on attach (LWW), it travels with the document.
 *
 * Authorship discipline: author metadata must NEVER enter the document tree
 * itself (span props serialize into markdown and echo through the op
 * stream). It lives strictly in the side-channel maps — same discipline as
 * blob references and cursors.
 *
 * Version capture (leading + rolling aggregation): the FIRST local edit
 * opens a version entry immediately — no waiting for an idle timer — and
 * subsequent edits within the rolling `captureIdleMs` window fold into that
 * same entry (its snapshot/authors refresh on a short `burstRefreshMs`
 * pause; the entry is replaced in place via delete+insert — each client
 * only ever rewrites entries it created itself, so there is no concurrent
 * contention). An edit arriving after the window opens a fresh entry.
 *
 * Attribution: the capturing client is only the shutter, NOT the author —
 * remote edits landing inside the capture window would otherwise be
 * silently credited to the capturer. A version's `authors` is computed by
 * reverse-looking-up the diff's touched spans in the (precise, CRDT-synced)
 * authorship map. `author` remains the capture initiator (fallback +
 * restore attribution).
 *
 * Core stays collaboration-agnostic: everything here consumes only the
 * public sync seam (subscribeRenderDataOps / getRenderDataSnapshot /
 * flushPendingInput). No core changes required.
 */
import * as Y from "yjs";
import type {
    CrdtCapableStore,
    RenderDataOp,
    SerializedRenderData,
} from "../crdt-sync/types";
import { ROOT_KEY, reconcileYTree } from "../crdt-sync/y-mapping";

/** Transaction origin for this plugin's side-channel writes. Realtime-sync
 *  broadcasts them (origin !== its REMOTE origin) and its root observer
 *  ignores them (they never touch the document tree). */
export const VERSIONING_ORIGIN = "domd-versioning-local";

/** Transaction origin for version restore. Deliberately NOT realtime-sync's
 *  LOCAL_ORIGIN: its root observer treats the restore like an inbound
 *  remote transaction and replays it into the local store through the
 *  op-level hot path — while doc.on("update") still broadcasts it to every
 *  peer. One reconcile transact, all sides converge. */
export const RESTORE_ORIGIN = "domd-versioning-restore";

export const AUTHORSHIP_KEY = "domdAuthorship";
export const COLLABORATORS_KEY = "domdCollaborators";
export const VERSIONS_KEY = "domdVersions";

/** Rolling aggregation window: edits closer than this to the burst's last
 *  edit fold into the same version entry. */
const DEFAULT_CAPTURE_IDLE_MS = 15_000;
/** Short pause after which the open burst entry's snapshot is refreshed
 *  (every-keystroke refresh would broadcast an O(doc) snapshot per key). */
const DEFAULT_BURST_REFRESH_MS = 2_000;
/** Timeline cap — oldest entries are pruned so the doc bytes stay bounded. */
const MAX_VERSIONS = 100;

export interface CollaboratorInfo {
    name: string;
    color: string;
}

export interface VersionEntry {
    id: string;
    /** Room clientId of the client that CAPTURED this version (the shutter,
     *  not necessarily the content's author). Display fallback + restore
     *  attribution. */
    author: string;
    /** Every collaborator whose spans changed in this version's diff
     *  (authorship reverse-lookup). Multi-author when remote edits landed
     *  inside the capture window. Absent on entries predating this field —
     *  fall back to `author`. */
    authors?: string[];
    ts: number;
    /** JSON.stringify(SerializedRenderData) at capture time. */
    snapshot: string;
    /** First entry stamped for a doc that predates any version history.
     *  Displayed as a baseline, not as the author's own edit. */
    initial?: boolean;
    /** Set when this entry was produced by restoring an older version:
     *  the id of the version that was restored. */
    restoredFrom?: string;
}

export interface LeafDelta {
    uuid: string;
    text: string;
}

export interface VersionDiff {
    added: LeafDelta[];
    edited: LeafDelta[];
    removed: LeafDelta[];
}

export interface AttachVersioningOptions {
    /** The session's shared doc (the one realtime-sync attached to). */
    doc: Y.Doc;
    /** Durable room identity (RoomRecord.clientId) — NOT the Yjs clientID. */
    clientId: string;
    name: string;
    color: string;
    /** Viewer mode: read panel data but register no identity, record no
     *  authorship, capture no versions (viewers are invisible by design). */
    observeOnly?: boolean;
    /** Rolling aggregation window (default 15s). */
    captureIdleMs?: number;
    /** Burst-entry refresh pause (default 2s). */
    burstRefreshMs?: number;
}

export interface VersioningHandle {
    clientId: string;
    /** True for viewer sessions: panel data is readable but restore (and
     *  every other write) is disabled. */
    observeOnly: boolean;
    getCollaborators(): Record<string, CollaboratorInfo>;
    subscribeCollaborators(
        listener: (collaborators: Record<string, CollaboratorInfo>) => void,
    ): () => void;
    /** Version entries sorted by timestamp ascending. */
    getVersions(): VersionEntry[];
    subscribeVersions(listener: (versions: VersionEntry[]) => void): () => void;
    /** spanUuid -> author clientId. */
    getAuthorship(): Record<string, string>;
    subscribeAuthorship(
        listener: (authorship: Record<string, string>) => void,
    ): () => void;
    /** Uuids of spans authored by the given collaborator. */
    authoredUuids(clientId: string): string[];
    /** Finalize the open burst entry with the latest content immediately
     *  (no-op when nothing changed or no burst is open). */
    captureNow(): Promise<void>;
    /**
     * Roll the document forward to an older version's content (industry
     * semantics: restore is a NEW edit on top of history, never a rewind —
     * history stays append-only and the pre-restore content is preserved as
     * its own version first). Applied as a uuid-keyed Y-tree reconcile, so
     * untouched spans keep their identities and authorship, and re-restored
     * spans revive their original authors. Returns false when the version
     * is unknown, identical to the current content, or the session is
     * observe-only.
     */
    restoreVersion(versionId: string): Promise<boolean>;
    dispose(): void;
}

// ---------------------------------------------------------------------------
// Snapshot helpers.
// ---------------------------------------------------------------------------

const collectUuids = (node: SerializedRenderData, out: string[]): void => {
    out.push(node.uuid);
    node.children?.forEach((child) => collectUuids(child, out));
};

/** Uuids a local op batch touches with authored content. Deletes carry no
 *  authorship (the span is gone; nothing left to color). */
const touchedUuids = (ops: RenderDataOp[]): string[] => {
    const out: string[] = [];
    for (const op of ops) {
        if (op.op === "insert" || op.op === "replaceRoot") {
            collectUuids(op.node, out);
        } else if (op.op === "set") {
            out.push(op.uuid);
            if (op.key === "children" && Array.isArray(op.value)) {
                (op.value as SerializedRenderData[]).forEach((child) =>
                    collectUuids(child, out),
                );
            }
        }
    }
    return out;
};

/** uuid -> text for every non-empty text leaf (empty leaves and pure
 *  containers carry nothing colorable and only add diff noise). */
const collectLeafTexts = (
    node: SerializedRenderData,
    out: Map<string, string>,
): void => {
    if (node.text !== undefined) {
        if (node.text.length > 0) out.set(node.uuid, node.text);
        return;
    }
    node.children?.forEach((child) => collectLeafTexts(child, out));
};

/**
 * Leaf-level structural diff between two version snapshots (uuid-keyed —
 * spans are immutable atoms, so identity comparison is exact). Props-only
 * changes are not tracked; text is the unit users reason about.
 * `prevJson` null = diff against the empty document (initial version).
 */
export const diffVersions = (
    prevJson: string | null,
    nextJson: string,
): VersionDiff => {
    const prev = new Map<string, string>();
    if (prevJson) {
        collectLeafTexts(JSON.parse(prevJson) as SerializedRenderData, prev);
    }
    const next = new Map<string, string>();
    collectLeafTexts(JSON.parse(nextJson) as SerializedRenderData, next);

    const diff: VersionDiff = { added: [], edited: [], removed: [] };
    for (const [uuid, text] of next) {
        const before = prev.get(uuid);
        if (before === undefined) diff.added.push({ uuid, text });
        else if (before !== text) diff.edited.push({ uuid, text });
    }
    for (const [uuid, text] of prev) {
        if (!next.has(uuid)) diff.removed.push({ uuid, text });
    }
    return diff;
};

// ---------------------------------------------------------------------------

export const attachVersioning = (
    store: CrdtCapableStore,
    options: AttachVersioningOptions,
): VersioningHandle => {
    const { doc, clientId, name, color } = options;
    const observeOnly = options.observeOnly === true;
    const captureIdleMs = options.captureIdleMs ?? DEFAULT_CAPTURE_IDLE_MS;
    const burstRefreshMs = options.burstRefreshMs ?? DEFAULT_BURST_REFRESH_MS;

    const authorship = doc.getMap<string>(AUTHORSHIP_KEY);
    const collaborators = doc.getMap<CollaboratorInfo>(COLLABORATORS_KEY);
    const versions = doc.getArray<VersionEntry>(VERSIONS_KEY);
    const rootNode = doc.getMap<unknown>(ROOT_KEY);

    let disposed = false;
    /** The version entry currently aggregating this client's edit burst. */
    let burst: { id: string; lastOpsAt: number } | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let captureCounter = 0;

    // ---- Identity registration (LWW; rename/recolor updates ride along) ----
    if (!observeOnly) {
        const existing = collaborators.get(clientId);
        if (!existing || existing.name !== name || existing.color !== color) {
            doc.transact(() => {
                collaborators.set(clientId, { name, color });
            }, VERSIONING_ORIGIN);
        }
    }

    // ---- Version capture ----
    /** Credit every collaborator whose spans were added/edited between the
     *  two snapshots (authorship reverse-lookup) — remote edits landing in
     *  the capturer's idle window must not be credited to the capturer.
     *  Removed spans credit nobody (the deleter is untracked; the original
     *  author did not act); a pure-deletion diff falls back to the
     *  capturer, who issued the local deletion ops in the common case. */
    const diffAuthors = (
        prevJson: string | null,
        nextJson: string,
    ): string[] => {
        const diff = diffVersions(prevJson, nextJson);
        const authors = new Set<string>();
        for (const change of [...diff.added, ...diff.edited]) {
            const owner = authorship.get(change.uuid);
            if (owner) authors.add(owner);
        }
        if (authors.size === 0) authors.add(clientId);
        return [...authors];
    };

    const snapshotNow = (): string | Promise<string> => {
        if (!store.duringComposition) {
            // New cores flush synchronously on this fast path before returning
            // their already-resolved Promise; old cores return void.
            void store.flushPendingInput?.();
            return JSON.stringify(store.getRenderDataSnapshot());
        }
        return Promise.resolve(store.flushPendingInput?.()).then(() =>
            JSON.stringify(store.getRenderDataSnapshot()),
        );
    };

    /** Open a new version entry IMMEDIATELY (leading capture — the version
     *  appears on the first edit, not after an idle wait). */
    const openBurst = async () => {
        if (disposed || observeOnly) return;
        const snapshotResult = snapshotNow();
        const snapshot =
            typeof snapshotResult === "string"
                ? snapshotResult
                : await snapshotResult;
        const last = versions.length
            ? versions.get(versions.length - 1)
            : undefined;
        if (last && last.snapshot === snapshot) return; // nothing changed
        const id = `${clientId}:${Date.now()}:${++captureCounter}`;
        const authors = diffAuthors(last ? last.snapshot : null, snapshot);
        doc.transact(() => {
            versions.push([
                {
                    id,
                    author: clientId,
                    authors,
                    ts: Date.now(),
                    snapshot,
                },
            ]);
            if (versions.length > MAX_VERSIONS) {
                versions.delete(0, versions.length - MAX_VERSIONS);
            }
        }, VERSIONING_ORIGIN);
        burst = { id, lastOpsAt: Date.now() };
    };

    /** Fold the latest content into the open burst entry (replace in place;
     *  only entries this client created are ever rewritten, so peers never
     *  contend). Authors are re-derived against the entry's predecessor so
     *  remote edits that landed inside the window get credited. */
    const refreshBurst = async () => {
        if (disposed || observeOnly || !burst) return;
        const arr = versions.toArray();
        const index = arr.findIndex((v) => v.id === burst!.id);
        if (index === -1) {
            burst = null; // pruned or reorganized away
            return;
        }
        const snapshotResult = snapshotNow();
        const snapshot =
            typeof snapshotResult === "string"
                ? snapshotResult
                : await snapshotResult;
        const entry = arr[index];
        if (entry.snapshot === snapshot) return;
        const authors = diffAuthors(
            index > 0 ? arr[index - 1].snapshot : null,
            snapshot,
        );
        doc.transact(() => {
            versions.delete(index, 1);
            versions.insert(index, [{ ...entry, authors, snapshot }]);
        }, VERSIONING_ORIGIN);
    };
    const scheduleRefresh = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            void refreshBurst();
        }, burstRefreshMs);
    };

    // Baseline: a doc without history gets an initial entry so every later
    // version has a well-defined predecessor. Concurrent first-attaches can
    // race into two baselines (both survive the Y merge) — harmless, the
    // panel renders them as baselines either way.
    if (!observeOnly && versions.length === 0) {
        doc.transact(() => {
            versions.push([
                {
                    id: `${clientId}:${Date.now()}:${++captureCounter}`,
                    author: clientId,
                    ts: Date.now(),
                    snapshot: JSON.stringify(store.getRenderDataSnapshot()),
                    initial: true,
                },
            ]);
        }, VERSIONING_ORIGIN);
    }

    // ---- Authorship recording (local ops only — remote applications go
    // through applyExternalRenderData(Ops) and are never re-emitted) ----
    const unsubscribeOps = observeOnly
        ? () => {}
        : store.subscribeRenderDataOps((ops) => {
              const uuids = touchedUuids(ops);
              if (uuids.length) {
                  doc.transact(() => {
                      for (const uuid of uuids) {
                          if (authorship.get(uuid) !== clientId) {
                              authorship.set(uuid, clientId);
                          }
                      }
                  }, VERSIONING_ORIGIN);
              }
              const now = Date.now();
              if (burst && now - burst.lastOpsAt <= captureIdleMs) {
                  // Inside the rolling window: fold into the open entry.
                  burst.lastOpsAt = now;
                  scheduleRefresh();
              } else {
                  // Window expired (or first edit): new version, right now.
                  burst = null;
                  void openBurst();
                  // Catch the trailing speculative-input tail of this burst.
                  scheduleRefresh();
              }
          });

    // ---- Read surface ----
    const getCollaborators = () =>
        collaborators.toJSON() as Record<string, CollaboratorInfo>;
    const getAuthorship = () => authorship.toJSON() as Record<string, string>;
    const getVersions = () =>
        versions.toArray().slice().sort((a, b) => a.ts - b.ts);

    const restoreVersion = async (versionId: string): Promise<boolean> => {
        if (disposed || observeOnly) return false;
        const entry = versions.toArray().find((v) => v.id === versionId);
        if (!entry) return false;
        const currentSnapshot = snapshotNow();
        const currentJson =
            typeof currentSnapshot === "string"
                ? currentSnapshot
                : await currentSnapshot;
        if (currentJson === entry.snapshot) return false;
        const target = JSON.parse(entry.snapshot) as SerializedRenderData;
        // The restore closes any open burst — its content is preserved by
        // the pre-restore capture below.
        clearTimeout(refreshTimer);
        burst = null;
        doc.transact(() => {
            // Preserve the pre-restore content as its own version so the
            // restore is always reversible through the same timeline.
            const last = versions.length
                ? versions.get(versions.length - 1)
                : undefined;
            if (!last || last.snapshot !== currentJson) {
                versions.push([
                    {
                        id: `${clientId}:${Date.now()}:${++captureCounter}`,
                        author: clientId,
                        authors: diffAuthors(
                            last ? last.snapshot : null,
                            currentJson,
                        ),
                        ts: Date.now(),
                        snapshot: currentJson,
                    },
                ]);
            }
            reconcileYTree(rootNode, target);
            versions.push([
                {
                    id: `${clientId}:${Date.now()}:${++captureCounter}`,
                    author: clientId,
                    // Restoring is the restorer's own act.
                    authors: [clientId],
                    ts: Date.now(),
                    snapshot: entry.snapshot,
                    restoredFrom: entry.id,
                },
            ]);
            if (versions.length > MAX_VERSIONS) {
                versions.delete(0, versions.length - MAX_VERSIONS);
            }
        }, RESTORE_ORIGIN);
        return true;
    };

    return {
        clientId,
        observeOnly,
        getCollaborators,
        subscribeCollaborators: (listener) => {
            const observer = () => listener(getCollaborators());
            collaborators.observe(observer);
            listener(getCollaborators());
            return () => collaborators.unobserve(observer);
        },
        getVersions,
        subscribeVersions: (listener) => {
            const observer = () => listener(getVersions());
            versions.observe(observer);
            listener(getVersions());
            return () => versions.unobserve(observer);
        },
        getAuthorship,
        subscribeAuthorship: (listener) => {
            const observer = () => listener(getAuthorship());
            authorship.observe(observer);
            listener(getAuthorship());
            return () => authorship.unobserve(observer);
        },
        authoredUuids: (author: string) => {
            const out: string[] = [];
            authorship.forEach((value, key) => {
                if (value === author) out.push(key);
            });
            return out;
        },
        captureNow: refreshBurst,
        restoreVersion,
        dispose: () => {
            if (disposed) return;
            clearTimeout(refreshTimer);
            // Finalize the open burst so the persisted bytes carry it.
            void refreshBurst();
            disposed = true;
            unsubscribeOps();
        },
    };
};
