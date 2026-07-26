export type RoomRole = "host" | "guest" | "viewer";

/**
 * A collaboration room this browser participates in. Persisted in IndexedDB
 * (Dexie) so sessions survive reloads and offline periods.
 *
 * Security note: the room password is NEVER stored — only the derived
 * non-extractable AES-GCM CryptoKey (IndexedDB can structured-clone it).
 * `linkSecret` is kept only for passwordless rooms so the host can rebuild
 * the invite link (the secret rides the URL fragment and never reaches any
 * server).
 */
export interface RoomRecord {
    id: string;
    role: RoomRole;
    /** Stable transport/realtime client id for this browser in this room. */
    clientId: string;
    displayName: string;
    color: string;
    /** Invite expiry, unix seconds. 0 = never expires. */
    exp: number;
    /** Link-embedded secret for passwordless rooms; null when password-gated. */
    linkSecret: string | null;
    /** Key-check value (hex) — lets a joiner detect a wrong password locally
     *  instead of waiting on a connection that can never establish. */
    keyCheck: string;
    key: CryptoKey;
    /** 1 = live, 0 = closed/dissolved (numeric for Dexie indexing). */
    active: number;
    createdAt: number;
    updatedAt: number;
}

export interface RoomDocRecord {
    roomId: string;
    /** Full Y.Doc state (Y.encodeStateAsUpdate) — the shared-origin bytes. */
    bytes: Uint8Array;
    updatedAt: number;
}

export interface DraftRecord {
    id: string;
    md: string;
    /** Display name of the document the draft mirrors (e.g. "notes.md"). */
    name?: string;
    updatedAt: number;
}
