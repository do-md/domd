"use client";
/**
 * Versioning side panel: one aggregated entry point for "who did what"
 * (industry pattern: Google Docs / Notion version history).
 *
 * Two linked views sharing one highlight engine (AuthorHighlights, rendered
 * by the page INSIDE the DOMDProvider — this panel only computes targets):
 *
 * - Collaborators legend: everyone who ever edited (from the in-doc
 *   registry, so offline authors resolve too). Selecting people highlights
 *   every span they authored, in their color (live blame view).
 * - Version timeline: idle-captured snapshots, newest first, each stamped
 *   with author + time + change counts. Selecting a version highlights its
 *   added/edited spans (vs the previous version) and lists text excerpts.
 *
 * The two selection modes are mutually exclusive (they would overdraw each
 * other); selecting in one clears the other.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    diffVersions,
    type CollaboratorInfo,
    type VersionDiff,
    type VersionEntry,
    type VersioningHandle,
} from "@/plugins/collaboration/versioning";
import type { HighlightTarget } from "@/plugins/collaboration/versioning/author-highlights";

const EXCERPT_MAX = 48;
const EXCERPTS_SHOWN = 8;
const FALLBACK_COLOR = "#8a7aa8";

const excerpt = (text: string): string =>
    text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text;

const formatTime = (ts: number): string => {
    const date = new Date(ts);
    const now = new Date();
    const sameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    const time = date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
    });
    return sameDay
        ? time
        : `${date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
          })} ${time}`;
};

export function HistoryIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 3" />
        </svg>
    );
}

function CloseIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
        >
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    );
}

type Selection =
    | { kind: "authors"; ids: string[] }
    | { kind: "version"; id: string }
    | null;

interface VersionRow {
    entry: VersionEntry;
    diff: VersionDiff | null; // null for the baseline entry
}

export function VersioningPanel({
    handle,
    selfClientId,
    onClose,
    onHighlightsChange,
    onlineClientIds = [],
}: {
    handle: VersioningHandle;
    selfClientId: string;
    onClose: () => void;
    onHighlightsChange: (targets: HighlightTarget[]) => void;
    /** Presence: clientIds currently online (from realtime peers). Self is
     *  always shown online regardless. */
    onlineClientIds?: string[];
}) {
    const { t } = useTranslation();
    const [collaborators, setCollaborators] = useState<
        Record<string, CollaboratorInfo>
    >(() => handle.getCollaborators());
    const [versions, setVersions] = useState<VersionEntry[]>(() =>
        handle.getVersions(),
    );
    const [authorship, setAuthorship] = useState<Record<string, string>>(() =>
        handle.getAuthorship(),
    );
    const [selection, setSelection] = useState<Selection>(null);
    /** Version id awaiting inline restore confirmation (never a native
     *  dialog — it would block the session). */
    const [confirmingRestore, setConfirmingRestore] = useState<string | null>(
        null,
    );

    useEffect(() => handle.subscribeCollaborators(setCollaborators), [handle]);
    useEffect(() => handle.subscribeVersions(setVersions), [handle]);
    useEffect(() => handle.subscribeAuthorship(setAuthorship), [handle]);

    // Newest first, with per-row diffs against the chronological predecessor.
    const rows = useMemo<VersionRow[]>(() => {
        const list: VersionRow[] = versions.map((entry, i) => ({
            entry,
            diff:
                i === 0
                    ? entry.initial
                        ? null
                        : diffVersions(null, entry.snapshot)
                    : diffVersions(versions[i - 1].snapshot, entry.snapshot),
        }));
        return list.reverse();
    }, [versions]);

    const colorOf = (clientId: string): string =>
        collaborators[clientId]?.color ?? FALLBACK_COLOR;
    const nameOf = (clientId: string): string =>
        collaborators[clientId]?.name ?? clientId.slice(0, 6);
    /** Everyone credited for a version. Entries predating the `authors`
     *  field fall back to the capturer. */
    const authorsOf = (entry: VersionEntry): string[] =>
        entry.authors && entry.authors.length > 0
            ? entry.authors
            : [entry.author];
    /** Diff/blame views share one color source: the span's true author.
     *  Spans missing from the authorship map fall back to the capturer. */
    const spanColor = (uuid: string, entry: VersionEntry): string =>
        colorOf(authorship[uuid] ?? entry.author);

    // Selection -> highlight targets (pushed up; the page renders the
    // overlay inside the DOMDProvider).
    useEffect(() => {
        if (!selection) {
            onHighlightsChange([]);
            return;
        }
        if (selection.kind === "authors") {
            const targets: HighlightTarget[] = [];
            for (const [uuid, author] of Object.entries(authorship)) {
                if (selection.ids.includes(author)) {
                    targets.push({ uuid, color: colorOf(author) });
                }
            }
            onHighlightsChange(targets);
            return;
        }
        const row = rows.find((r) => r.entry.id === selection.id);
        if (!row || !row.diff) {
            onHighlightsChange([]);
            return;
        }
        onHighlightsChange(
            [...row.diff.added, ...row.diff.edited].map((c) => ({
                uuid: c.uuid,
                color: spanColor(c.uuid, row.entry),
            })),
        );
        // colorOf identity is stable per collaborators snapshot.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection, authorship, rows, collaborators, onHighlightsChange]);

    // Clear highlights when the panel unmounts.
    useEffect(() => () => onHighlightsChange([]), [onHighlightsChange]);

    const toggleAuthor = (clientId: string) => {
        setSelection((prev) => {
            const ids =
                prev?.kind === "authors"
                    ? prev.ids.includes(clientId)
                        ? prev.ids.filter((id) => id !== clientId)
                        : [...prev.ids, clientId]
                    : [clientId];
            return ids.length ? { kind: "authors", ids } : null;
        });
    };
    const toggleVersion = (id: string) => {
        setConfirmingRestore(null);
        setSelection((prev) =>
            prev?.kind === "version" && prev.id === id
                ? null
                : { kind: "version", id },
        );
    };

    const handleRestore = async (id: string) => {
        const restored = await handle.restoreVersion(id);
        setConfirmingRestore(null);
        // Successful restore appends new entries; drop the stale selection
        // (and its highlights) so the timeline reads fresh.
        if (restored) setSelection(null);
    };

    const collaboratorIds = Object.keys(collaborators);

    return (
        <aside className="flex h-full w-72 max-w-[85vw] flex-col border-l border-base-content/10 bg-base-100">
            <header className="shrink-0 flex items-center gap-2 px-4 h-11 border-b border-base-content/10">
                <HistoryIcon className="size-4 text-base-content/50" />
                <h3 className="flex-1 text-sm font-semibold truncate">
                    {t("versioning.title")}
                </h3>
                <button
                    onClick={onClose}
                    className="btn btn-xs btn-ghost btn-square text-base-content/50"
                    aria-label={t("common.close")}
                >
                    <CloseIcon className="size-3.5" />
                </button>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto">
                {/* ---- Collaborators legend ---- */}
                <section className="px-4 pt-4 pb-2">
                    <h4 className="text-[11px] font-medium uppercase tracking-wide text-base-content/40 mb-2">
                        {t("versioning.collaborators")}
                    </h4>
                    {collaboratorIds.length === 0 ? (
                        <p className="text-xs text-base-content/50">
                            {t("versioning.noCollaborators")}
                        </p>
                    ) : (
                        <>
                            <ul className="space-y-1">
                                {collaboratorIds.map((clientId) => {
                                    const selected =
                                        selection?.kind === "authors" &&
                                        selection.ids.includes(clientId);
                                    return (
                                        <li key={clientId}>
                                            <button
                                                onClick={() =>
                                                    toggleAuthor(clientId)
                                                }
                                                className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                                                    selected
                                                        ? "bg-base-200"
                                                        : "hover:bg-base-200/50"
                                                }`}
                                                style={
                                                    selected
                                                        ? {
                                                              boxShadow: `inset 2px 0 0 ${colorOf(clientId)}`,
                                                          }
                                                        : undefined
                                                }
                                            >
                                                <span
                                                    className="inline-block size-2 rounded-full shrink-0"
                                                    style={{
                                                        background:
                                                            colorOf(clientId),
                                                    }}
                                                />
                                                <span className="flex-1 truncate">
                                                    {nameOf(clientId)}
                                                </span>
                                                {clientId === selfClientId ? (
                                                    <span className="badge badge-xs badge-soft shrink-0">
                                                        {t("versioning.you")}
                                                    </span>
                                                ) : null}
                                                {clientId === selfClientId ||
                                                onlineClientIds.includes(
                                                    clientId,
                                                ) ? (
                                                    <span className="flex items-center gap-1 text-[10px] text-success/70 shrink-0">
                                                        <span className="inline-block size-1.5 rounded-full bg-success/70" />
                                                        {t(
                                                            "versioning.online",
                                                        )}
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1 text-[10px] text-base-content/30 shrink-0">
                                                        <span className="inline-block size-1.5 rounded-full bg-base-content/25" />
                                                        {t(
                                                            "versioning.offline",
                                                        )}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                            <p className="mt-2 text-[11px] leading-4 text-base-content/40">
                                {t("versioning.colorHint")}
                            </p>
                        </>
                    )}
                </section>

                {/* ---- Version timeline ---- */}
                <section className="px-4 pt-2 pb-4">
                    <h4 className="text-[11px] font-medium uppercase tracking-wide text-base-content/40 mb-2">
                        {t("versioning.versions")}
                    </h4>
                    {rows.length === 0 ? (
                        <p className="text-xs text-base-content/50">
                            {t("versioning.noVersions")}
                        </p>
                    ) : (
                        <ul className="space-y-1">
                            {rows.map(({ entry, diff }) => {
                                const selected =
                                    selection?.kind === "version" &&
                                    selection.id === entry.id;
                                const entryAuthors = authorsOf(entry);
                                const color = colorOf(entryAuthors[0]);
                                return (
                                    <li key={entry.id}>
                                        <button
                                            onClick={() =>
                                                toggleVersion(entry.id)
                                            }
                                            className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                                                selected
                                                    ? "bg-base-200"
                                                    : "hover:bg-base-200/50"
                                            }`}
                                            style={
                                                selected
                                                    ? {
                                                          boxShadow: `inset 2px 0 0 ${color}`,
                                                      }
                                                    : undefined
                                            }
                                        >
                                            <span className="flex items-center gap-2 text-sm">
                                                <span className="flex shrink-0 -space-x-0.5">
                                                    {entryAuthors
                                                        .slice(0, 3)
                                                        .map((a) => (
                                                            <span
                                                                key={a}
                                                                className="inline-block size-2 rounded-full ring-1 ring-base-100"
                                                                style={{
                                                                    background:
                                                                        colorOf(
                                                                            a,
                                                                        ),
                                                                }}
                                                            />
                                                        ))}
                                                </span>
                                                <span className="flex-1 truncate">
                                                    {entry.initial
                                                        ? t(
                                                              "versioning.initialVersion",
                                                          )
                                                        : entryAuthors
                                                              .map(nameOf)
                                                              .join(", ")}
                                                </span>
                                                {entry.restoredFrom ? (
                                                    <span className="badge badge-xs badge-soft shrink-0">
                                                        {t(
                                                            "versioning.restoredBadge",
                                                        )}
                                                    </span>
                                                ) : null}
                                                <span className="text-[11px] text-base-content/40 shrink-0">
                                                    {formatTime(entry.ts)}
                                                </span>
                                            </span>
                                            {diff ? (
                                                <span className="mt-0.5 flex gap-2 pl-4 text-[11px] text-base-content/45">
                                                    {diff.added.length ? (
                                                        <span>
                                                            {t(
                                                                "versioning.added",
                                                                {
                                                                    count: diff
                                                                        .added
                                                                        .length,
                                                                },
                                                            )}
                                                        </span>
                                                    ) : null}
                                                    {diff.edited.length ? (
                                                        <span>
                                                            {t(
                                                                "versioning.edited",
                                                                {
                                                                    count: diff
                                                                        .edited
                                                                        .length,
                                                                },
                                                            )}
                                                        </span>
                                                    ) : null}
                                                    {diff.removed.length ? (
                                                        <span>
                                                            {t(
                                                                "versioning.removed",
                                                                {
                                                                    count: diff
                                                                        .removed
                                                                        .length,
                                                                },
                                                            )}
                                                        </span>
                                                    ) : null}
                                                    {!diff.added.length &&
                                                    !diff.edited.length &&
                                                    !diff.removed.length ? (
                                                        <span>
                                                            {t(
                                                                "versioning.noTextChanges",
                                                            )}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            ) : null}
                                        </button>
                                        {selected ? (
                                            <div className="mt-1 mb-1 ml-4 border-l border-base-content/10 pl-3">
                                                {diff ? (
                                                    <ul className="space-y-0.5">
                                                        {[
                                                            ...diff.added.map(
                                                                (c) =>
                                                                    [
                                                                        "+",
                                                                        c,
                                                                    ] as const,
                                                            ),
                                                            ...diff.edited.map(
                                                                (c) =>
                                                                    [
                                                                        "~",
                                                                        c,
                                                                    ] as const,
                                                            ),
                                                            ...diff.removed.map(
                                                                (c) =>
                                                                    [
                                                                        "−",
                                                                        c,
                                                                    ] as const,
                                                            ),
                                                        ]
                                                            .slice(
                                                                0,
                                                                EXCERPTS_SHOWN,
                                                            )
                                                            .map(
                                                                (
                                                                    [sign, c],
                                                                    i,
                                                                ) => (
                                                                    <li
                                                                        key={i}
                                                                        className="flex gap-1.5 text-[11px] leading-4"
                                                                    >
                                                                        <span
                                                                            className="shrink-0 font-mono"
                                                                            style={{
                                                                                color: spanColor(
                                                                                    c.uuid,
                                                                                    entry,
                                                                                ),
                                                                            }}
                                                                        >
                                                                            {
                                                                                sign
                                                                            }
                                                                        </span>
                                                                        <span className="truncate text-base-content/60">
                                                                            {excerpt(
                                                                                c.text,
                                                                            )}
                                                                        </span>
                                                                    </li>
                                                                ),
                                                            )}
                                                    </ul>
                                                ) : null}
                                                {!handle.observeOnly ? (
                                                    confirmingRestore ===
                                                    entry.id ? (
                                                        <div className="mt-1.5">
                                                            <p className="text-[11px] leading-4 text-base-content/50 mb-1.5">
                                                                {t(
                                                                    "versioning.restoreConfirm",
                                                                )}
                                                            </p>
                                                            <div className="flex gap-1.5">
                                                                <button
                                                                    onClick={() =>
                                                                        void handleRestore(
                                                                            entry.id,
                                                                        )
                                                                    }
                                                                    className="btn btn-xs btn-primary"
                                                                >
                                                                    {t(
                                                                        "versioning.restore",
                                                                    )}
                                                                </button>
                                                                <button
                                                                    onClick={() =>
                                                                        setConfirmingRestore(
                                                                            null,
                                                                        )
                                                                    }
                                                                    className="btn btn-xs btn-ghost"
                                                                >
                                                                    {t(
                                                                        "collab.cancel",
                                                                    )}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() =>
                                                                setConfirmingRestore(
                                                                    entry.id,
                                                                )
                                                            }
                                                            className="btn btn-xs btn-outline mt-1.5"
                                                        >
                                                            {t(
                                                                "versioning.restore",
                                                            )}
                                                        </button>
                                                    )
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        </aside>
    );
}
