/**
 * Persistence layer for the CRDT playground: it mimics real multiple clients —
 * each client only publishes its own state to storage, and a merge reads the
 * other side's latest publish from storage (never a direct in-memory link).
 *
 * v1 uses localStorage: synchronous read/write is simple and enough at
 * playground scale (a few hundred KB); once documents grow, this can move to
 * IndexedDB behind the same interface. Both the markdown text (human-readable,
 * handy for comparison) and the CRDT state (base64) are stored.
 */

export type CrdtClientId = "A" | "B";

const PREFIX = "domd-crdt-playground";

const key = (id: CrdtClientId, kind: "state" | "md" | "savedAt") =>
    `${PREFIX}:${id}:${kind}`;

export interface CrdtClientSnapshot {
    /** Full Yjs state (base64). */
    state: string;
    /** Markdown text at that moment (display/comparison only; the source of truth is `state`). */
    md: string;
    savedAt: number;
}

export const saveClientSnapshot = (
    id: CrdtClientId,
    snapshot: CrdtClientSnapshot,
): void => {
    try {
        localStorage.setItem(key(id, "state"), snapshot.state);
        localStorage.setItem(key(id, "md"), snapshot.md);
        localStorage.setItem(key(id, "savedAt"), String(snapshot.savedAt));
    } catch {
        // localStorage full / private mode: silently ignore in the playground.
    }
};

export const loadClientSnapshot = (
    id: CrdtClientId,
): CrdtClientSnapshot | null => {
    try {
        const state = localStorage.getItem(key(id, "state"));
        if (!state) return null;
        return {
            state,
            md: localStorage.getItem(key(id, "md")) ?? "",
            savedAt: Number(localStorage.getItem(key(id, "savedAt")) ?? 0),
        };
    } catch {
        return null;
    }
};

export const clearClientSnapshot = (id: CrdtClientId): void => {
    try {
        localStorage.removeItem(key(id, "state"));
        localStorage.removeItem(key(id, "md"));
        localStorage.removeItem(key(id, "savedAt"));
    } catch {
        // ignore
    }
};

export const clearAllSnapshots = (): void => {
    clearClientSnapshot("A");
    clearClientSnapshot("B");
};
