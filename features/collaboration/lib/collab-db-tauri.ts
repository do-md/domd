/**
 * Desktop persistence backend for collaboration data. Mirrors collab-db.ts
 * (the Dexie/IndexedDB backend) but stores everything in one machine-global
 * SQLite database — `~/.domd/collab.db` — via Tauri invoke commands (see
 * src-tauri/src/collab_db.rs). Rooms are keyed to the document's frontmatter
 * `domd-id`, which exists from the moment a document is created; whether the
 * file has ever been saved to disk is irrelevant to collaboration.
 *
 * CryptoKey wrinkle: IndexedDB structured-clones non-extractable CryptoKeys,
 * SQLite cannot. Desktop room keys are therefore derived extractable (see
 * share-modal), exported to raw bytes for storage, and re-imported on load.
 * The raw key already rests on the local disk inside the database, so keeping
 * the in-memory key extractable adds no additional exposure.
 */
import { tauriCore } from "@/common/lib/tauri";
import {
    base64ToUint8,
    uint8ToBase64,
} from "@/plugins/collaboration/crdt-sync";
import type { RoomRecord } from "./types";

/** Frontmatter domd-id of the document open in this window. One window
 *  hosts one document, so module-level state is safe. */
let currentDocId: string | null = null;

export const setCollabDocId = (docId: string): void => {
    currentDocId = docId;
};

export const clearCollabDocId = (): void => {
    currentDocId = null;
};

// ---- Row <-> RoomRecord (CryptoKey + bytes serialization) ----

interface RoomRow {
    id: string;
    docId: string;
    role: string;
    clientId: string;
    displayName: string;
    color: string;
    exp: number;
    linkSecret: string | null;
    keyCheck: string;
    keyRaw: string;
    active: number;
    createdAt: number;
    updatedAt: number;
}

const toRow = async (room: RoomRecord, docId: string): Promise<RoomRow> => {
    const raw = await crypto.subtle.exportKey("raw", room.key);
    return {
        id: room.id,
        docId,
        role: room.role,
        clientId: room.clientId,
        displayName: room.displayName,
        color: room.color,
        exp: room.exp,
        linkSecret: room.linkSecret,
        keyCheck: room.keyCheck,
        keyRaw: uint8ToBase64(new Uint8Array(raw)),
        active: room.active,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
    };
};

const fromRow = async (row: RoomRow): Promise<RoomRecord> => {
    // Extractable on re-import so a later putRoom can round-trip the key.
    const key = await crypto.subtle.importKey(
        "raw",
        base64ToUint8(row.keyRaw) as BufferSource,
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"],
    );
    return {
        id: row.id,
        role: row.role as RoomRecord["role"],
        clientId: row.clientId,
        displayName: row.displayName,
        color: row.color,
        exp: row.exp,
        linkSecret: row.linkSecret,
        keyCheck: row.keyCheck,
        key,
        active: row.active,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

// ---- Rooms ----

export const putRoom = async (room: RoomRecord): Promise<void> => {
    if (!currentDocId) throw new Error("collab doc id not set");
    const { invoke } = await tauriCore();
    const row = await toRow(room, currentDocId);
    await invoke("collab_put_room", { room: row });
};

export const getRoom = async (id: string): Promise<RoomRecord | undefined> => {
    const { invoke } = await tauriCore();
    const row = await invoke<RoomRow | null>("collab_get_room", { id });
    return row ? fromRow(row) : undefined;
};

/** The active hosted room for the CURRENT document (per-doc on desktop,
 *  unlike the web backend's browser-global lookup). */
export const getActiveHostRoom = async (): Promise<RoomRecord | undefined> => {
    if (!currentDocId) return undefined;
    const { invoke } = await tauriCore();
    const row = await invoke<RoomRow | null>("collab_active_host_room", {
        docId: currentDocId,
    });
    return row ? fromRow(row) : undefined;
};

export const deactivateRoom = async (id: string): Promise<void> => {
    const { invoke } = await tauriCore();
    await invoke("collab_deactivate_room", { id });
};

export const deleteRoomData = async (id: string): Promise<void> => {
    const { invoke } = await tauriCore();
    await invoke("collab_delete_room", { id });
};

// ---- Room doc bytes ----

export const saveRoomDocBytes = async (
    roomId: string,
    bytes: Uint8Array,
): Promise<void> => {
    const { invoke } = await tauriCore();
    await invoke("collab_save_doc_bytes", {
        roomId,
        bytesB64: uint8ToBase64(bytes),
    });
};

export const loadRoomDocBytes = async (
    roomId: string,
): Promise<Uint8Array | undefined> => {
    const { invoke } = await tauriCore();
    const b64 = await invoke<string | null>("collab_load_doc_bytes", {
        roomId,
    });
    return b64 ? base64ToUint8(b64) : undefined;
};
