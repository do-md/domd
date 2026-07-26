/**
 * SignalRoomDO — one Durable Object per collaboration room, using the
 * WebSocket Hibernation API so idle rooms cost nothing.
 *
 * Protocol (JSON text frames):
 *   server -> client on join:      {t:"peers", peers:[clientId...]}   (others)
 *   server -> others on join:      {t:"peer-joined", id}
 *   server -> others on leave:     {t:"peer-left", id}
 *   client -> server:              {t:"signal", to, payload}          (opaque ciphertext)
 *   server -> target:              {t:"signal", from, payload}
 *   client -> server keepalive:    {t:"ping"} -> {t:"pong"}           (auto-response, no DO wake)
 *
 * Close codes: 4001 room expired, 4002 replaced by a newer session with the
 * same client id.
 *
 * Expiry: the first client to ever join records the room's exp (unix
 * seconds, 0 = never); later joins past exp are rejected and an alarm wipes
 * the room record. The exp is baked into the clients' key derivation, so a
 * client lying about exp to the DO still cannot talk to honest peers.
 */

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_ROOM_SOCKETS = 32;

interface Attachment {
    clientId: string;
}

export class SignalRoomDO {
    private state: DurableObjectState;

    constructor(state: DurableObjectState) {
        this.state = state;
        this.state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
        );
    }

    private clientIdOf(ws: WebSocket): string | null {
        try {
            const attachment = ws.deserializeAttachment() as Attachment | null;
            return attachment?.clientId ?? null;
        } catch {
            return null;
        }
    }

    private broadcast(message: string, except?: WebSocket): void {
        for (const ws of this.state.getWebSockets()) {
            if (ws === except) continue;
            try {
                ws.send(message);
            } catch {
                // socket already gone; hibernation close handler cleans up
            }
        }
    }

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("expected websocket", { status: 426 });
        }
        const url = new URL(request.url);
        const clientId = url.searchParams.get("client") ?? "";
        const exp = Math.floor(Number(url.searchParams.get("exp") ?? "0")) || 0;
        if (!ID_RE.test(clientId)) {
            return new Response("bad client id", { status: 400 });
        }

        const pair = new WebSocketPair();
        const server = pair[1];

        let storedExp = await this.state.storage.get<number>("exp");
        if (storedExp === undefined) {
            storedExp = exp;
            await this.state.storage.put("exp", exp);
            if (exp > 0) {
                // Wipe the room record shortly after expiry.
                await this.state.storage.setAlarm(exp * 1000 + 60_000);
            }
        }
        const expired = storedExp > 0 && Date.now() / 1000 > storedExp;
        const full = this.state.getWebSockets().length >= MAX_ROOM_SOCKETS;
        if (expired || full) {
            // Accept then close so the browser client sees the code.
            server.accept();
            server.close(expired ? 4001 : 1013, expired ? "expired" : "full");
            return new Response(null, { status: 101, webSocket: pair[0] });
        }

        // A reconnect with the same client id replaces the older session.
        for (const ws of this.state.getWebSockets()) {
            if (this.clientIdOf(ws) === clientId) {
                try {
                    ws.close(4002, "replaced");
                } catch {
                    // already closing
                }
            }
        }

        const others: string[] = [];
        for (const ws of this.state.getWebSockets()) {
            const id = this.clientIdOf(ws);
            if (id && id !== clientId) others.push(id);
        }

        this.state.acceptWebSocket(server);
        server.serializeAttachment({ clientId } satisfies Attachment);
        server.send(JSON.stringify({ t: "peers", peers: others }));
        this.broadcast(
            JSON.stringify({ t: "peer-joined", id: clientId }),
            server,
        );

        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    async webSocketMessage(
        ws: WebSocket,
        raw: string | ArrayBuffer,
    ): Promise<void> {
        if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;
        const from = this.clientIdOf(ws);
        if (!from) return;
        let msg: { t?: string; to?: string; payload?: string };
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (
            msg.t !== "signal" ||
            typeof msg.to !== "string" ||
            typeof msg.payload !== "string" ||
            !ID_RE.test(msg.to)
        ) {
            return;
        }
        const forwarded = JSON.stringify({
            t: "signal",
            from,
            payload: msg.payload,
        });
        for (const target of this.state.getWebSockets()) {
            if (this.clientIdOf(target) === msg.to) {
                try {
                    target.send(forwarded);
                } catch {
                    // target gone; close handler cleans up
                }
            }
        }
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
        const id = this.clientIdOf(ws);
        if (id) {
            this.broadcast(JSON.stringify({ t: "peer-left", id }), ws);
        }
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        const id = this.clientIdOf(ws);
        if (id) {
            this.broadcast(JSON.stringify({ t: "peer-left", id }), ws);
        }
    }

    async alarm(): Promise<void> {
        for (const ws of this.state.getWebSockets()) {
            try {
                ws.close(4001, "expired");
            } catch {
                // already closing
            }
        }
        await this.state.storage.deleteAll();
    }
}
