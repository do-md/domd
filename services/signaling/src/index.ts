/**
 * DOMD collaboration signaling worker. Routes WebSocket upgrades to one
 * Durable Object per room (idFromName(roomId)). The service is a pure relay:
 * room membership notifications + opaque password-encrypted SDP/ICE blobs.
 * It never sees document content, cursor data, or the room password.
 */
export { SignalRoomDO } from "./room-do";

export interface Env {
    ROOM_DO: DurableObjectNamespace;
    /** Cloudflare TURN key id + its API token (secret). When unset, the
     *  /turn-credentials endpoint reports no TURN and clients fall back to
     *  STUN-only (direct paths still work). */
    TURN_KEY_ID?: string;
    TURN_KEY_API_TOKEN?: string;
}

const ROOM_PATH = /^\/c\/([A-Za-z0-9_-]{4,64})$/;
const TURN_TTL_SECONDS = 4 * 3600;

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
};

/** Mint short-lived TURN credentials from the long-lived TURN key. The key
 *  itself never leaves the worker; clients only ever see credentials that
 *  expire within hours. */
const turnCredentials = async (env: Env): Promise<Response> => {
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return new Response(JSON.stringify({ iceServers: [] }), {
            headers: { "content-type": "application/json", ...CORS_HEADERS },
        });
    }
    const upstream = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}` +
            "/credentials/generate-ice-servers",
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        },
    );
    if (!upstream.ok) {
        return new Response("turn upstream error", {
            status: 502,
            headers: CORS_HEADERS,
        });
    }
    return new Response(await upstream.text(), {
        headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
            return new Response("ok", {
                headers: { "access-control-allow-origin": "*" },
            });
        }
        if (url.pathname === "/turn-credentials") {
            if (request.method === "OPTIONS") {
                return new Response(null, { headers: CORS_HEADERS });
            }
            return turnCredentials(env);
        }
        const match = ROOM_PATH.exec(url.pathname);
        if (!match) {
            return new Response("not found", { status: 404 });
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("expected websocket", { status: 426 });
        }
        const id = env.ROOM_DO.idFromName(match[1]);
        return env.ROOM_DO.get(id).fetch(request);
    },
};
