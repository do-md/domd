/**
 * Serverless password gate: the room secret (a user password, or a random
 * link-embedded secret for passwordless rooms) is stretched with PBKDF2 into
 * an AES-GCM key that encrypts every signaling payload. Nobody verifies the
 * password online — a wrong key simply cannot produce or read valid
 * signaling, so no peer connection ever forms.
 *
 * The expiry timestamp is baked into the salt: changing the expiry (or
 * recreating the room) rotates the key, so stale invites cannot piggyback on
 * a new session.
 *
 * The key-check value (KCV) exists purely for UX: without it, a guest with a
 * wrong password is indistinguishable from "no peer online". It is derived
 * with the same PBKDF2 cost as the key (an offline guess against the KCV is
 * as expensive as one against the key itself) and truncated to 3 bytes.
 */
import { customAlphabet } from "nanoid";

const PBKDF2_ITERATIONS = 300_000;
/** Matches the signaling service's id rule ([A-Za-z0-9_-]{4,64}). */
const idAlphabet = customAlphabet(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_",
);

export const generateRoomId = (): string => idAlphabet(12);
export const generateClientId = (): string => idAlphabet(10);
export const generateLinkSecret = (): string => idAlphabet(16);

const importSecret = (secret: string): Promise<CryptoKey> =>
    crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveKey", "deriveBits"],
    );

const saltFor = (purpose: string, roomId: string, exp: number): Uint8Array =>
    new TextEncoder().encode(`domd-${purpose}:${roomId}:${exp}`);

/** Non-extractable AES-GCM room key (safe to persist via structured clone). */
export const deriveRoomKey = async (
    secret: string,
    roomId: string,
    exp: number,
): Promise<CryptoKey> => {
    const base = await importSecret(secret);
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: saltFor("room", roomId, exp) as BufferSource,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
};

/** 3-byte hex key-check value carried in the invite link. */
export const deriveKeyCheck = async (
    secret: string,
    roomId: string,
    exp: number,
): Promise<string> => {
    const base = await importSecret(secret);
    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: saltFor("kcv", roomId, exp) as BufferSource,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        base,
        24,
    );
    return [...new Uint8Array(bits)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
};
