/**
 * Platform dispatcher for collaboration persistence. Call sites (share
 * modal, collab bridge, editor app) import from HERE; the backend is picked
 * at call time:
 *
 *  - Web:     collab-db.ts     (Dexie / IndexedDB, browser-global)
 *  - Desktop: collab-db-tauri.ts (SQLite in `{doc dir}/.domd/collab.db`,
 *             scoped to the frontmatter domd-id of the open document)
 *
 * Drafts intentionally stay web-only (desktop autosaves to the real file) —
 * import those directly from collab-db.
 */
import { isTauri } from "@/common/lib/platform";
import * as webDb from "./collab-db";
import * as tauriDb from "./collab-db-tauri";
import type { RoomRecord } from "./types";

export const putRoom = (room: RoomRecord): Promise<void> =>
    isTauri() ? tauriDb.putRoom(room) : webDb.putRoom(room);

export const getRoom = (id: string): Promise<RoomRecord | undefined> =>
    isTauri() ? tauriDb.getRoom(id) : webDb.getRoom(id);

/** Web: the (at most one) room this browser hosts. Desktop: the active
 *  hosted room of the document open in this window. */
export const getActiveHostRoom = (): Promise<RoomRecord | undefined> =>
    isTauri() ? tauriDb.getActiveHostRoom() : webDb.getActiveHostRoom();

export const deactivateRoom = (id: string): Promise<void> =>
    isTauri() ? tauriDb.deactivateRoom(id) : webDb.deactivateRoom(id);

export const deleteRoomData = (id: string): Promise<void> =>
    isTauri() ? tauriDb.deleteRoomData(id) : webDb.deleteRoomData(id);

export const saveRoomDocBytes = (
    roomId: string,
    bytes: Uint8Array,
): Promise<void> =>
    isTauri()
        ? tauriDb.saveRoomDocBytes(roomId, bytes)
        : webDb.saveRoomDocBytes(roomId, bytes);

export const loadRoomDocBytes = (
    roomId: string,
): Promise<Uint8Array | undefined> =>
    isTauri()
        ? tauriDb.loadRoomDocBytes(roomId)
        : webDb.loadRoomDocBytes(roomId);
