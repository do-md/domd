/**
 * WebRTC transport for realtime-sync: a full mesh of RTCPeerConnections
 * negotiated through a tiny signaling service (Cloudflare Worker + Durable
 * Object, see services/signaling). After negotiation ALL sync traffic flows
 * peer-to-peer over data channels — no document data ever touches a server.
 *
 * Serverless password gate: the caller derives an AES-GCM key from the room
 * password (or the link-embedded secret) and every signaling payload (SDP
 * offers/answers, ICE candidates) is encrypted with it. A client holding the
 * wrong key can neither produce nor read valid signaling, so no data channel
 * is ever established with it — the signaling server only relays opaque
 * ciphertext and never sees the password. Data channels themselves are
 * DTLS-encrypted by WebRTC.
 *
 * Topology: deterministic offerer per pair (the lexicographically smaller
 * client id offers) — no glare and no renegotiation (one pre-created data
 * channel, no media). If a link drops while the peer is still present in the
 * signaling room, the offerer re-offers with backoff. Established peer links
 * survive signaling outages; the socket reconnects independently.
 *
 * Message codec: JSON with Uint8Array fields transposed to base64 markers,
 * chunked under the cross-browser SCTP message-size ceiling.
 */
import { base64ToUint8, uint8ToBase64 } from "../crdt-sync/y-mapping";
import type { RealtimeTransport } from "./index";

export type SignalingState =
    | "connecting"
    | "open"
    | "closed"
    | "expired"
    | "unreachable";

export interface WebRtcTransportStatus {
    signaling: SignalingState;
    /** Peer ids present in the signaling room (not necessarily connected —
     *  distinguishes "nobody online" from "P2P negotiation failing"). */
    roomPeers: string[];
    /** Peer ids with an open data channel. */
    connectedPeers: string[];
}

export interface WebRtcTransportOptions {
    /** ws(s):// origin of the signaling worker, no trailing slash. */
    signalingUrl: string;
    roomId: string;
    /** MUST equal the clientId passed to attachRealtimeSync (targeted
     *  delivery routes by this id). */
    clientId: string;
    /** AES-GCM room key derived from the password / link secret. */
    key: CryptoKey;
    /** Invite expiry (unix seconds, 0 = never). Enforced client-side and by
     *  the signaling room; baked into key derivation by the caller. */
    exp: number;
    iceServers?: RTCIceServer[];
    onStatusChange?: (status: WebRtcTransportStatus) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

// Two SCTP streams per peer: doc sync (small, latency sensitive) and blob
// transfer (bulk). Separate streams so megabytes of image bytes never
// head-of-line-block keystrokes. Both are created IN-BAND by the offerer and
// dispatched by label on the answerer — `negotiated:true` channels created
// before setRemoteDescription can silently never open on the answerer side
// (observed in Chrome), so in-band DCEP is the reliable path.
const DATA_CHANNEL_LABEL = "domd-sync";
const BLOB_CHANNEL_LABEL = "domd-blob";
const CHUNK_SIZE = 60_000; // stay under the 64 KiB cross-browser SCTP floor
const PING_INTERVAL_MS = 30_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;
const OFFER_RETRY_BASE_MS = 1_500;
const OFFER_RETRY_MAX_MS = 15_000;

// ---------------------------------------------------------------------------
// Wire codec (structured message <-> data channel string).
// ---------------------------------------------------------------------------

const U8_MARK = "__domd_u8";
const CHUNK_MARK = "__domd_chunk";

const encodeMessage = (message: unknown): string =>
    JSON.stringify(message, (_key, value) =>
        value instanceof Uint8Array ? { [U8_MARK]: uint8ToBase64(value) } : value,
    );

const decodeMessage = (text: string): unknown =>
    JSON.parse(text, (_key, value) =>
        value && typeof value === "object" && typeof value[U8_MARK] === "string"
            ? base64ToUint8(value[U8_MARK])
            : value,
    );

interface ChunkFrame {
    [CHUNK_MARK]: { id: string; index: number; total: number; data: string };
}

const isChunkFrame = (value: unknown): value is ChunkFrame =>
    typeof value === "object" &&
    value !== null &&
    CHUNK_MARK in (value as Record<string, unknown>);

// ---------------------------------------------------------------------------
// Signaling payload crypto (AES-GCM over JSON).
// ---------------------------------------------------------------------------

const encryptPayload = async (
    key: CryptoKey,
    payload: unknown,
): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plaintext,
    );
    return `${uint8ToBase64(iv)}.${uint8ToBase64(new Uint8Array(ciphertext))}`;
};

/** Returns null on any failure — an undecryptable payload simply means the
 *  sender does not hold the room key and is ignored. */
const decryptPayload = async (
    key: CryptoKey,
    payload: string,
): Promise<unknown | null> => {
    try {
        const [ivB64, ctB64] = payload.split(".");
        if (!ivB64 || !ctB64) return null;
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToUint8(ivB64) as BufferSource },
            key,
            base64ToUint8(ctB64) as BufferSource,
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        return null;
    }
};

type SignalBody =
    | { k: "offer"; sdp: string }
    | { k: "answer"; sdp: string }
    | { k: "ice"; candidate: RTCIceCandidateInit | null };

type ServerMessage =
    | { t: "peers"; peers: string[] }
    | { t: "peer-joined"; id: string }
    | { t: "peer-left"; id: string }
    | { t: "signal"; from: string; payload: string }
    | { t: "pong" };

// ---------------------------------------------------------------------------

interface PeerLink {
    pc: RTCPeerConnection;
    channel: RTCDataChannel | null;
    blobChannel: RTCDataChannel | null;
    connected: boolean;
    retryCount: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
    /** Buffered remote ICE candidates until the remote description lands. */
    pendingIce: RTCIceCandidateInit[];
    hasRemoteDescription: boolean;
    closed: boolean;
}

export interface WebRtcTransport extends RealtimeTransport {
    getStatus(): WebRtcTransportStatus;
    /** Subscribe to the dedicated per-peer BLOB channels (bulk transfer,
     *  isolated from doc sync). Already-open channels replay on subscribe. */
    onBlobChannel(
        handler: (peerId: string, channel: RTCDataChannel) => void,
    ): () => void;
}

export const createWebRtcTransport = (
    options: WebRtcTransportOptions,
): WebRtcTransport => {
    const { signalingUrl, roomId, clientId, key, exp } = options;
    const iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;

    let disposed = false;
    let ws: WebSocket | null = null;
    let signalingState: SignalingState = "connecting";
    let wsRetryCount = 0;
    let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    /** Peers currently present in the signaling room (excluding self). */
    const roomPeers = new Set<string>();
    const links = new Map<string, PeerLink>();

    const messageHandlers = new Set<(message: unknown) => void>();
    const peerConnectHandlers = new Set<(peerId: string) => void>();
    const peerDisconnectHandlers = new Set<(peerId: string) => void>();
    const blobChannelHandlers = new Set<
        (peerId: string, channel: RTCDataChannel) => void
    >();

    // Reassembly buffers keyed by `${peerId}:${chunkId}`.
    const chunkBuffers = new Map<
        string,
        { total: number; parts: (string | undefined)[]; received: number }
    >();
    let chunkCounter = 0;

    const emitStatus = () => {
        options.onStatusChange?.(getStatus());
    };
    const getStatus = (): WebRtcTransportStatus => ({
        signaling: signalingState,
        roomPeers: [...roomPeers],
        connectedPeers: [...links.entries()]
            .filter(([, link]) => link.connected)
            .map(([id]) => id),
    });

    const isExpired = () => exp > 0 && Date.now() / 1000 > exp;

    /** The deterministic offerer for a pair is the smaller client id. */
    const isOfferer = (peerId: string) => clientId < peerId;

    /** ICE diagnostics ([collab-rtc] prefix): connection-state transitions
     *  at info level, per-candidate detail at debug level (enable Verbose in
     *  devtools). Tells apart "no candidates gathered" (firewall/VPN),
     *  "candidates exchanged but checks fail" (AP isolation / NAT hairpin /
     *  needs TURN), and "connected". */
    const logState = (peerId: string, what: string) => {
        console.info(`[collab-rtc] peer=${peerId} ${what}`);
    };
    const candidateType = (candidate: string | undefined): string => {
        if (!candidate) return "end-of-candidates";
        return /typ (\w+)/.exec(candidate)?.[1] ?? "unknown";
    };
    /** Log which candidate pair actually carries the connection (host =
     *  direct LAN, srflx = NAT-mapped direct, relay = TURN). */
    const logSelectedPair = (peerId: string, pc: RTCPeerConnection) => {
        void pc
            .getStats()
            .then((stats) => {
                interface PairStats {
                    type?: string;
                    state?: string;
                    nominated?: boolean;
                    localCandidateId?: string;
                    remoteCandidateId?: string;
                    candidateType?: string;
                }
                stats.forEach((report: PairStats) => {
                    if (
                        report.type !== "candidate-pair" ||
                        report.state !== "succeeded" ||
                        !report.nominated
                    ) {
                        return;
                    }
                    const local = stats.get(
                        report.localCandidateId ?? "",
                    ) as PairStats | undefined;
                    const remote = stats.get(
                        report.remoteCandidateId ?? "",
                    ) as PairStats | undefined;
                    logState(
                        peerId,
                        `selected pair: local=${local?.candidateType} ` +
                            `remote=${remote?.candidateType}`,
                    );
                });
            })
            .catch(() => {
                // stats unavailable — diagnostics only
            });
    };

    // ---- Data channel plumbing ----

    const handleChannelText = (peerId: string, text: string) => {
        let decoded: unknown;
        try {
            decoded = decodeMessage(text);
        } catch {
            return;
        }
        if (isChunkFrame(decoded)) {
            const { id, index, total, data } = decoded[CHUNK_MARK];
            const bufKey = `${peerId}:${id}`;
            let buf = chunkBuffers.get(bufKey);
            if (!buf) {
                buf = { total, parts: new Array(total), received: 0 };
                chunkBuffers.set(bufKey, buf);
            }
            if (buf.parts[index] === undefined) {
                buf.parts[index] = data;
                buf.received += 1;
            }
            if (buf.received < buf.total) return;
            chunkBuffers.delete(bufKey);
            try {
                decoded = decodeMessage(buf.parts.join(""));
            } catch {
                return;
            }
        }
        messageHandlers.forEach((handler) => handler(decoded));
    };

    const sendOnChannel = (channel: RTCDataChannel, message: unknown) => {
        const encoded = encodeMessage(message);
        if (encoded.length <= CHUNK_SIZE) {
            channel.send(encoded);
            return;
        }
        const id = `${clientId}-${++chunkCounter}`;
        const total = Math.ceil(encoded.length / CHUNK_SIZE);
        for (let index = 0; index < total; index += 1) {
            const frame: ChunkFrame = {
                [CHUNK_MARK]: {
                    id,
                    index,
                    total,
                    data: encoded.slice(
                        index * CHUNK_SIZE,
                        (index + 1) * CHUNK_SIZE,
                    ),
                },
            };
            channel.send(JSON.stringify(frame));
        }
    };

    const wireChannel = (peerId: string, link: PeerLink) => {
        const channel = link.channel;
        if (!channel) return;
        // Idempotent: an already-open channel handled eagerly may STILL fire
        // onopen afterwards — double-processing must be impossible (a second
        // peer-connect would double-subscribe listeners downstream).
        let opened = false;
        const handleOpen = () => {
            if (opened || disposed || link.closed) return;
            opened = true;
            logState(peerId, "data channel open");
            logSelectedPair(peerId, link.pc);
            link.connected = true;
            link.retryCount = 0;
            emitStatus();
            peerConnectHandlers.forEach((handler) => handler(peerId));
        };
        channel.onopen = handleOpen;
        // ondatachannel may deliver an already-open channel (no further
        // onopen event) — cover both cases.
        if (channel.readyState === "open") handleOpen();
        channel.onmessage = (event: MessageEvent) => {
            if (typeof event.data === "string") {
                handleChannelText(peerId, event.data);
            }
        };
        channel.onclose = () => {
            if (disposed || link.closed) return;
            const wasConnected = link.connected;
            destroyLink(peerId, link);
            if (wasConnected) {
                peerDisconnectHandlers.forEach((handler) => handler(peerId));
            }
            emitStatus();
            scheduleReoffer(peerId, link.retryCount + 1);
        };
    };

    const wireBlobChannel = (peerId: string, link: PeerLink) => {
        const channel = link.blobChannel;
        if (!channel) return;
        channel.binaryType = "arraybuffer";
        // Idempotent for the same reason as wireChannel: a duplicate open
        // notification would double-subscribe blob-sync's message listener
        // and corrupt chunk accounting.
        let opened = false;
        const handleOpen = () => {
            if (opened || disposed || link.closed) return;
            opened = true;
            logState(peerId, "blob channel open");
            blobChannelHandlers.forEach((handler) => handler(peerId, channel));
        };
        channel.onopen = handleOpen;
        if (channel.readyState === "open") handleOpen();
        // Lifecycle (close/error) is observed by blob-sync via
        // addEventListener; link teardown closes the channel below.
    };

    // ---- Peer link lifecycle ----

    const destroyLink = (peerId: string, link: PeerLink) => {
        link.closed = true;
        if (link.retryTimer) clearTimeout(link.retryTimer);
        if (link.channel) {
            link.channel.onopen = null;
            link.channel.onmessage = null;
            link.channel.onclose = null;
            try {
                link.channel.close();
            } catch {
                // already closed
            }
        }
        if (link.blobChannel) {
            link.blobChannel.onopen = null;
            try {
                link.blobChannel.close(); // fires "close" for blob-sync cleanup
            } catch {
                // already closed
            }
        }
        link.pc.onicecandidate = null;
        link.pc.onconnectionstatechange = null;
        link.pc.ondatachannel = null;
        try {
            link.pc.close();
        } catch {
            // already closed
        }
        if (links.get(peerId) === link) links.delete(peerId);
    };

    /** Offerer-side retry while the peer is still in the signaling room. */
    const scheduleReoffer = (peerId: string, retryCount: number) => {
        if (disposed || !isOfferer(peerId)) return;
        if (!roomPeers.has(peerId)) return;
        const delay = Math.min(
            OFFER_RETRY_BASE_MS * 2 ** Math.min(retryCount, 6),
            OFFER_RETRY_MAX_MS,
        );
        setTimeout(() => {
            if (disposed || links.has(peerId) || !roomPeers.has(peerId)) return;
            void startOffer(peerId, retryCount);
        }, delay);
    };

    const createLink = (peerId: string, retryCount: number): PeerLink => {
        const pc = new RTCPeerConnection({ iceServers });
        const link: PeerLink = {
            pc,
            channel: null,
            blobChannel: null,
            connected: false,
            retryCount,
            retryTimer: null,
            pendingIce: [],
            hasRemoteDescription: false,
            closed: false,
        };
        links.set(peerId, link);
        if (isOfferer(peerId)) {
            // Offerer creates both channels in-band before the offer.
            link.channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
            wireChannel(peerId, link);
            link.blobChannel = pc.createDataChannel(BLOB_CHANNEL_LABEL);
            wireBlobChannel(peerId, link);
        } else {
            // Answerer receives them via DCEP, dispatched by label.
            pc.ondatachannel = (event) => {
                if (link.closed) return;
                if (event.channel.label === BLOB_CHANNEL_LABEL) {
                    link.blobChannel = event.channel;
                    wireBlobChannel(peerId, link);
                } else {
                    link.channel = event.channel;
                    wireChannel(peerId, link);
                }
            };
        }
        pc.onicecandidate = (event) => {
            console.debug(
                `[collab-rtc] peer=${peerId} local candidate: ` +
                    candidateType(event.candidate?.candidate),
            );
            void sendSignal(peerId, {
                k: "ice",
                candidate: event.candidate ? event.candidate.toJSON() : null,
            });
        };
        pc.oniceconnectionstatechange = () => {
            logState(peerId, `ice=${pc.iceConnectionState}`);
        };
        pc.onconnectionstatechange = () => {
            if (disposed || link.closed) return;
            logState(peerId, `connection=${pc.connectionState}`);
            if (
                pc.connectionState === "failed" ||
                pc.connectionState === "closed"
            ) {
                const wasConnected = link.connected;
                destroyLink(peerId, link);
                if (wasConnected) {
                    peerDisconnectHandlers.forEach((handler) =>
                        handler(peerId),
                    );
                }
                emitStatus();
                scheduleReoffer(peerId, link.retryCount + 1);
            }
        };
        return link;
    };

    const startOffer = async (peerId: string, retryCount = 0) => {
        if (disposed || links.has(peerId) || isExpired()) return;
        const link = createLink(peerId, retryCount);
        try {
            const offer = await link.pc.createOffer();
            await link.pc.setLocalDescription(offer);
            await sendSignal(peerId, { k: "offer", sdp: offer.sdp ?? "" });
        } catch {
            destroyLink(peerId, link);
            scheduleReoffer(peerId, retryCount + 1);
        }
    };

    const handleSignal = async (from: string, payload: string) => {
        const body = (await decryptPayload(key, payload)) as SignalBody | null;
        if (!body || disposed) return; // wrong key or malformed -> ignore
        if (body.k === "offer") {
            // A fresh offer supersedes any existing link from this peer.
            const existing = links.get(from);
            if (existing) destroyLink(from, existing);
            const link = createLink(from, 0);
            try {
                await link.pc.setRemoteDescription({
                    type: "offer",
                    sdp: body.sdp,
                });
                link.hasRemoteDescription = true;
                for (const candidate of link.pendingIce.splice(0)) {
                    await link.pc.addIceCandidate(candidate ?? undefined);
                }
                const answer = await link.pc.createAnswer();
                await link.pc.setLocalDescription(answer);
                await sendSignal(from, { k: "answer", sdp: answer.sdp ?? "" });
            } catch {
                destroyLink(from, link);
            }
            return;
        }
        const link = links.get(from);
        if (!link || link.closed) return;
        if (body.k === "answer") {
            try {
                await link.pc.setRemoteDescription({
                    type: "answer",
                    sdp: body.sdp,
                });
                link.hasRemoteDescription = true;
                for (const candidate of link.pendingIce.splice(0)) {
                    await link.pc.addIceCandidate(candidate ?? undefined);
                }
            } catch {
                destroyLink(from, link);
                scheduleReoffer(from, link.retryCount + 1);
            }
            return;
        }
        if (body.k === "ice") {
            console.debug(
                `[collab-rtc] peer=${from} remote candidate: ` +
                    candidateType(body.candidate?.candidate ?? undefined),
            );
            if (!link.hasRemoteDescription) {
                if (body.candidate) link.pendingIce.push(body.candidate);
                return;
            }
            try {
                await link.pc.addIceCandidate(body.candidate ?? undefined);
            } catch {
                // stale candidate for a torn-down link — ignore
            }
        }
    };

    const sendSignal = async (to: string, body: SignalBody) => {
        if (disposed || ws?.readyState !== WebSocket.OPEN) return;
        const payload = await encryptPayload(key, body);
        if (disposed || ws?.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ t: "signal", to, payload }));
    };

    // ---- Signaling socket ----

    const reconcilePeers = (ids: string[]) => {
        roomPeers.clear();
        for (const id of ids) {
            if (id !== clientId) roomPeers.add(id);
        }
        for (const id of roomPeers) {
            if (!links.has(id) && isOfferer(id)) void startOffer(id);
        }
        // Links whose peer left the signaling room: keep CONNECTED ones (p2p
        // is independent of signaling presence — the peer may only have lost
        // its socket), drop half-open negotiations.
        for (const [id, link] of links) {
            if (!roomPeers.has(id) && !link.connected) destroyLink(id, link);
        }
        emitStatus();
    };

    const handleServerMessage = (msg: ServerMessage) => {
        switch (msg.t) {
            case "peers":
                reconcilePeers(msg.peers);
                return;
            case "peer-joined":
                if (msg.id === clientId) return;
                roomPeers.add(msg.id);
                emitStatus();
                if (!links.has(msg.id) && isOfferer(msg.id)) {
                    void startOffer(msg.id);
                }
                return;
            case "peer-left": {
                roomPeers.delete(msg.id);
                const link = links.get(msg.id);
                if (link && !link.connected) destroyLink(msg.id, link);
                emitStatus();
                return;
            }
            case "signal":
                void handleSignal(msg.from, msg.payload);
                return;
            default:
                return;
        }
    };

    const scheduleWsReconnect = () => {
        if (disposed || wsRetryTimer) return;
        const delay = Math.min(
            WS_RECONNECT_BASE_MS * 2 ** Math.min(wsRetryCount, 5),
            WS_RECONNECT_MAX_MS,
        );
        wsRetryCount += 1;
        wsRetryTimer = setTimeout(() => {
            wsRetryTimer = null;
            connect();
        }, delay);
    };

    const connect = () => {
        if (disposed) return;
        if (isExpired()) {
            signalingState = "expired";
            emitStatus();
            return;
        }
        signalingState = "connecting";
        emitStatus();
        const socket = new WebSocket(
            `${signalingUrl}/c/${encodeURIComponent(roomId)}` +
                `?client=${encodeURIComponent(clientId)}&exp=${exp}`,
        );
        ws = socket;
        socket.onopen = () => {
            if (disposed || ws !== socket) return;
            wsRetryCount = 0;
            signalingState = "open";
            emitStatus();
        };
        socket.onmessage = (event: MessageEvent) => {
            if (disposed || ws !== socket) return;
            try {
                handleServerMessage(JSON.parse(String(event.data)));
            } catch {
                // malformed server frame — ignore
            }
        };
        socket.onclose = (event: CloseEvent) => {
            if (disposed || ws !== socket) return;
            ws = null;
            if (event.code === 4001) {
                signalingState = "expired";
                emitStatus();
                return; // room expired — do not reconnect
            }
            if (event.code === 4002) {
                signalingState = "closed";
                emitStatus();
                return; // replaced by a newer session with the same id
            }
            signalingState = "unreachable";
            emitStatus();
            scheduleWsReconnect();
        };
        socket.onerror = () => {
            // onclose follows and drives the retry
        };
    };

    const onOnline = () => {
        if (disposed || ws) return;
        if (wsRetryTimer) {
            clearTimeout(wsRetryTimer);
            wsRetryTimer = null;
        }
        wsRetryCount = 0;
        connect();
    };

    if (typeof window !== "undefined") {
        window.addEventListener("online", onOnline);
    }
    pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send('{"t":"ping"}');
        }
    }, PING_INTERVAL_MS);
    connect();

    // ---- RealtimeTransport surface ----

    return {
        post: (message) => {
            for (const link of links.values()) {
                if (link.connected && link.channel?.readyState === "open") {
                    try {
                        sendOnChannel(link.channel, message);
                    } catch {
                        // channel died mid-send; onclose will clean up
                    }
                }
            }
        },
        postTo: (peerId, message) => {
            const link = links.get(peerId);
            if (link?.connected && link.channel?.readyState === "open") {
                try {
                    sendOnChannel(link.channel, message);
                } catch {
                    // channel died mid-send; onclose will clean up
                }
            }
        },
        onMessage: (handler) => {
            messageHandlers.add(handler);
            return () => {
                messageHandlers.delete(handler);
            };
        },
        onPeerConnect: (handler) => {
            peerConnectHandlers.add(handler);
            return () => {
                peerConnectHandlers.delete(handler);
            };
        },
        onPeerDisconnect: (handler) => {
            peerDisconnectHandlers.add(handler);
            return () => {
                peerDisconnectHandlers.delete(handler);
            };
        },
        onBlobChannel: (handler) => {
            blobChannelHandlers.add(handler);
            for (const [peerId, link] of links) {
                if (link.blobChannel?.readyState === "open") {
                    handler(peerId, link.blobChannel);
                }
            }
            return () => {
                blobChannelHandlers.delete(handler);
            };
        },
        getStatus,
        close: () => {
            disposed = true;
            if (typeof window !== "undefined") {
                window.removeEventListener("online", onOnline);
            }
            if (pingTimer) clearInterval(pingTimer);
            if (wsRetryTimer) clearTimeout(wsRetryTimer);
            for (const [peerId, link] of [...links]) {
                destroyLink(peerId, link);
            }
            messageHandlers.clear();
            peerConnectHandlers.clear();
            peerDisconnectHandlers.clear();
            blobChannelHandlers.clear();
            const socket = ws;
            ws = null;
            socket?.close(1000);
        },
    };
};
