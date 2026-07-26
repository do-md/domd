/**
 * Invite link format (static export -> query params, matching the
 * /s/gist?id= convention; the secret rides the URL FRAGMENT so it never
 * appears in any server log):
 *
 *   <origin>/collab?id=<roomId>&exp=<unixSeconds>&kc=<keyCheckHex>[&v=1][#k=<linkSecret>]
 *
 * With a password set there is no fragment — the link alone is not enough
 * to join. Passwordless rooms embed the random secret in the fragment, so
 * possessing the link grants access.
 *
 * `v=1` marks a READ-ONLY (viewer) link. Both link flavors share the room
 * secret (a password-gated room has exactly one password), so read-only is a
 * cooperative client contract — same enforcement level as room dissolution —
 * not a cryptographic capability split. Viewers receive doc/presence pushes
 * but never emit edits or presence, and they skip the name prompt.
 */

export interface InviteParams {
    roomId: string;
    exp: number;
    keyCheck: string;
    /** Present only for passwordless rooms. */
    linkSecret: string | null;
    /** True for read-only (viewer) links. */
    readonly: boolean;
}

export const buildInviteUrl = (
    origin: string,
    invite: InviteParams,
): string => {
    const query = new URLSearchParams({
        id: invite.roomId,
        exp: String(invite.exp),
        kc: invite.keyCheck,
    });
    if (invite.readonly) query.set("v", "1");
    const fragment = invite.linkSecret
        ? `#k=${encodeURIComponent(invite.linkSecret)}`
        : "";
    return `${origin}/collab?${query.toString()}${fragment}`;
};

export const parseInvite = (
    searchParams: URLSearchParams,
    hash: string,
): InviteParams | null => {
    const roomId = searchParams.get("id");
    if (!roomId || !/^[A-Za-z0-9_-]{4,64}$/.test(roomId)) return null;
    const exp = Math.floor(Number(searchParams.get("exp") ?? "0")) || 0;
    const keyCheck = searchParams.get("kc") ?? "";
    const fragmentMatch = /(?:^|[#&])k=([^&]+)/.exec(hash);
    const linkSecret = fragmentMatch
        ? decodeURIComponent(fragmentMatch[1])
        : null;
    const readonly = searchParams.get("v") === "1";
    return { roomId, exp, keyCheck, linkSecret, readonly };
};

export const isInviteExpired = (exp: number): boolean =>
    exp > 0 && Date.now() / 1000 > exp;
