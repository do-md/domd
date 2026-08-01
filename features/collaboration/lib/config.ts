import { isTauri } from "@/common/lib/platform";

const DEPLOYED_SIGNALING_URL =
    "wss://domd-signaling.wangjintaoapp.workers.dev";

/** Origin baked into invite links: the origin the host actually loaded the
 *  app from (https://www.domd.app in prod, a proxied dev domain like
 *  https://home3000.domd.app:1113 in dev) — guests open the same deployment
 *  the host is on. NOT hardcoded; NEXT_PUBLIC_SHARE_ORIGIN overrides when
 *  links should point at a different canonical host.
 *
 *  Desktop wrinkle: a packaged Tauri app serves from tauri://localhost
 *  (macOS/Linux) or http://tauri.localhost (Windows) — neither is a
 *  joinable guest origin, so packaged desktop builds ALWAYS emit the
 *  canonical https://www.domd.app. The only desktop exception is `tauri
 *  dev`, whose webview loads the local dev server (localhost/127.0.0.1) —
 *  that IS joinable for same-machine testing and is kept. */
export const getShareOrigin = (): string => {
    const fromEnv = process.env.NEXT_PUBLIC_SHARE_ORIGIN;
    if (fromEnv) return fromEnv.replace(/\/$/, "");
    if (typeof window !== "undefined") {
        const { protocol, hostname, origin } = window.location;
        const isLocalDevServer =
            protocol === "http:" &&
            (hostname === "localhost" || hostname === "127.0.0.1");
        if (!isTauri()) return origin;
        if (isLocalDevServer) return origin;
    }
    return "https://www.domd.app";
};

/** Signaling worker endpoint (see services/signaling). Always the deployed
 *  worker so host and guests converge on the same room regardless of which
 *  origin each side loaded the app from (invite links point at the
 *  canonical origin — a localhost-only signaling fallback would split-brain
 *  a dev host from its guests). Override with NEXT_PUBLIC_SIGNALING_URL
 *  (e.g. ws://localhost:8787 against a local `wrangler dev`). */
export const getSignalingUrl = (): string => {
    const fromEnv = process.env.NEXT_PUBLIC_SIGNALING_URL;
    if (fromEnv) return fromEnv.replace(/\/$/, "");
    return DEPLOYED_SIGNALING_URL;
};

const STUN_SERVERS: RTCIceServer[] = [
    {
        urls: [
            "stun:stun.cloudflare.com:3478",
            "stun:stun.l.google.com:19302",
        ],
    },
];

let cachedIce: { servers: RTCIceServer[]; expiresAt: number } | null = null;

/** ICE servers: STUN for direct / NAT-mapped paths, plus Cloudflare TURN
 *  relay for networks where direct checks fail (router AP isolation, no NAT
 *  hairpin, carrier CGNAT). Short-lived TURN credentials are minted by the
 *  signaling worker (/turn-credentials — the long-lived TURN key never
 *  reaches clients; the relay only sees DTLS-encrypted packets). Falls back
 *  to STUN-only when the endpoint is unconfigured or unreachable. */
export const getIceServers = async (): Promise<RTCIceServer[]> => {
    if (cachedIce && Date.now() < cachedIce.expiresAt) {
        return cachedIce.servers;
    }
    try {
        const httpBase = getSignalingUrl().replace(/^ws/, "http");
        const resp = await fetch(`${httpBase}/turn-credentials`);
        if (resp.ok) {
            const body = (await resp.json()) as {
                iceServers?: RTCIceServer | RTCIceServer[];
            };
            const turn = Array.isArray(body.iceServers)
                ? body.iceServers
                : body.iceServers
                  ? [body.iceServers]
                  : [];
            if (turn.length > 0) {
                const servers = [...STUN_SERVERS, ...turn];
                // Refresh well before the 4h credential TTL runs out.
                cachedIce = {
                    servers,
                    expiresAt: Date.now() + 3 * 3600_000,
                };
                return servers;
            }
        }
    } catch {
        // fall through to STUN-only
    }
    return STUN_SERVERS;
};

/** Muted collaborator palette (host is always the first entry). */
export const HOST_COLOR = "#bf616a";
export const GUEST_COLORS = [
    "#5e81ac",
    "#7d9367",
    "#d08770",
    "#9d7bab",
    "#5f9b8c",
    "#a08072",
    "#ab8f56",
    "#718799",
];

export const pickGuestColor = (seed: string): string => {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    return GUEST_COLORS[Math.abs(hash) % GUEST_COLORS.length];
};
