/**
 * IndexedDB persistence for collaboration (Dexie). Chosen over localStorage
 * deliberately: Y.Doc states are binary (stored natively as Uint8Array, no
 * base64 inflation), writes are async (no main-thread jank on large docs),
 * and quota is far beyond localStorage's ~5 MB string budget.
 *
 * Separate database from the image store (common/lib/image-storage.ts) so
 * the two schemas can evolve independently.
 */
import Dexie, { type Table } from "dexie";
import type { DraftRecord, RoomDocRecord, RoomRecord } from "./types";
export type { DraftRecord } from "./types";

class CollabDb extends Dexie {
    rooms!: Table<RoomRecord, string>;
    docs!: Table<RoomDocRecord, string>;
    drafts!: Table<DraftRecord, string>;

    constructor() {
        super("domd-collab");
        this.version(1).stores({
            rooms: "id, role, active",
            docs: "roomId",
            drafts: "id",
        });
    }
}

const db = new CollabDb();

// ---- Rooms ----

export const putRoom = async (room: RoomRecord): Promise<void> => {
    await db.rooms.put(room);
};

export const getRoom = async (id: string): Promise<RoomRecord | undefined> =>
    db.rooms.get(id);

/** The room this browser is currently hosting, if any (at most one). */
export const getActiveHostRoom = async (): Promise<RoomRecord | undefined> =>
    db.rooms.filter((r) => r.role === "host" && r.active === 1).first();

export const deactivateRoom = async (id: string): Promise<void> => {
    await db.rooms.update(id, { active: 0, updatedAt: Date.now() });
};

/** Remove a room and its doc bytes entirely. */
export const deleteRoomData = async (id: string): Promise<void> => {
    await db.transaction("rw", db.rooms, db.docs, async () => {
        await db.rooms.delete(id);
        await db.docs.delete(id);
    });
};

// ---- Room doc bytes (shared-origin Y.Doc state) ----

export const saveRoomDocBytes = async (
    roomId: string,
    bytes: Uint8Array,
): Promise<void> => {
    await db.docs.put({ roomId, bytes, updatedAt: Date.now() });
};

export const loadRoomDocBytes = async (
    roomId: string,
): Promise<Uint8Array | undefined> => (await db.docs.get(roomId))?.bytes;

// ---- Local editor draft (web mode, unsaved document) ----

const DRAFT_ID = "editor";

export const saveDraft = async (md: string, name?: string): Promise<void> => {
    await db.drafts.put({ id: DRAFT_ID, md, name, updatedAt: Date.now() });
};

export const loadDraft = async (): Promise<DraftRecord | null> =>
    (await db.drafts.get(DRAFT_ID)) ?? null;

export const clearDraft = async (): Promise<void> => {
    await db.drafts.delete(DRAFT_ID);
};
