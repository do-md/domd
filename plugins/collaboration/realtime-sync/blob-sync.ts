/**
 * Content-addressed blob exchange over a DEDICATED per-peer data channel
 * (see webrtc-transport: negotiated SCTP stream separate from doc sync).
 * Rationale: bulk image bytes on the sync channel head-of-line-block every
 * keystroke behind megabytes of queued chunks, and an unthrottled send burst
 * can blow the browser's channel buffer and kill the connection outright.
 *
 * Protocol per channel (ordered, so a simple meta -> chunks -> end state
 * machine suffices; control frames are JSON text, chunk frames are raw
 * binary — no base64 inflation):
 *
 *   -> {k:"req",  id}                       ask for a blob
 *   <- {k:"miss", id}                       peer does not have it
 *   <- {k:"meta", id, mime, size}           transfer starts
 *   <- <binary chunk> * N                   16 KiB frames
 *   <- {k:"end",  id}                       transfer complete
 *
 * Sender backpressure: pause while bufferedAmount exceeds the high mark and
 * resume on bufferedamountlow — the transfer adapts to the link instead of
 * flooding it. One transfer at a time per channel (serialized queue).
 *
 * The requester broadcasts req to every open blob channel, first completed
 * transfer wins, and resolves early to null once EVERY reachable peer
 * replied miss. The caller MUST verify the content hash before storing —
 * ids are untrusted peer input.
 */

const CHUNK_BYTES = 16 * 1024;
const BUFFER_HIGH = 1 << 20; // pause sends above 1 MiB queued
const BUFFER_LOW = 256 * 1024; // resume below 256 KiB
const MAX_SERVE_BYTES = 20 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

type ControlFrame =
    | { k: "req"; id: string }
    | { k: "miss"; id: string }
    | { k: "meta"; id: string; mime: string; size: number }
    | { k: "end"; id: string };

export interface BlobProvider {
    has(id: string): Promise<boolean>;
    get(id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

export interface BlobChannelSource {
    /** Subscribe to per-peer blob channels; already-open channels replay. */
    onBlobChannel(
        handler: (peerId: string, channel: RTCDataChannel) => void,
    ): () => void;
}

export interface BlobSyncHandle {
    /** Resolve a blob from any online peer. Null when nobody has it or on
     *  timeout/dispose. */
    fetch(
        id: string,
        timeoutMs?: number,
    ): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
    dispose(): void;
}

interface IncomingTransfer {
    id: string;
    mime: string;
    size: number;
    bytes: Uint8Array;
    offset: number;
}

interface Pending {
    promise: Promise<{ bytes: Uint8Array; mimeType: string } | null>;
    resolve: (v: { bytes: Uint8Array; mimeType: string } | null) => void;
    timer: ReturnType<typeof setTimeout>;
    /** Channels asked and not yet answered with miss (early-null bookkeeping). */
    outstanding: Set<RTCDataChannel>;
}

export const attachBlobSync = (
    source: BlobChannelSource,
    provider: BlobProvider,
): BlobSyncHandle => {
    let disposed = false;

    const channels = new Map<string, RTCDataChannel>();
    const pending = new Map<string, Pending>();
    /** Per-channel state, keyed by the channel object (peers can reconnect
     *  with a fresh channel under the same peer id). */
    const incoming = new Map<RTCDataChannel, IncomingTransfer | null>();
    const serveQueues = new Map<RTCDataChannel, Promise<void>>();

    const log = (message: string) => {
        console.debug(`[collab-blob] ${message}`);
    };

    const settle = (
        id: string,
        value: { bytes: Uint8Array; mimeType: string } | null,
    ) => {
        const entry = pending.get(id);
        if (!entry) return;
        log(`settle ${id}: ${value ? value.bytes.byteLength + " bytes" : "null"}`);
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(value);
    };

    const sendControl = (channel: RTCDataChannel, frame: ControlFrame) => {
        if (channel.readyState !== "open") return;
        try {
            channel.send(JSON.stringify(frame));
        } catch {
            // channel died mid-send; close handler cleans up
        }
    };

    const waitForDrain = (channel: RTCDataChannel): Promise<void> =>
        new Promise((resolve) => {
            if (
                channel.bufferedAmount <= BUFFER_HIGH ||
                channel.readyState !== "open"
            ) {
                resolve();
                return;
            }
            const onLow = () => {
                channel.removeEventListener("bufferedamountlow", onLow);
                channel.removeEventListener("close", onLow);
                resolve();
            };
            channel.addEventListener("bufferedamountlow", onLow);
            channel.addEventListener("close", onLow);
        });

    const serve = async (channel: RTCDataChannel, id: string) => {
        if (disposed || channel.readyState !== "open") return;
        const blob = (await provider.has(id)) ? await provider.get(id) : null;
        log(
            `serve ${id}: ${blob ? blob.bytes.byteLength + " bytes" : "miss"} ` +
                `(channel=${channel.readyState})`,
        );
        if (disposed || channel.readyState !== "open") return;
        if (!blob || blob.bytes.byteLength > MAX_SERVE_BYTES) {
            if (blob) {
                console.warn(
                    `[collab-blob] not serving oversized blob ${id} ` +
                        `(${blob.bytes.byteLength} bytes)`,
                );
            }
            sendControl(channel, { k: "miss", id });
            return;
        }
        sendControl(channel, {
            k: "meta",
            id,
            mime: blob.mimeType,
            size: blob.bytes.byteLength,
        });
        try {
            for (
                let offset = 0;
                offset < blob.bytes.byteLength;
                offset += CHUNK_BYTES
            ) {
                await waitForDrain(channel);
                if (disposed || channel.readyState !== "open") return;
                channel.send(
                    blob.bytes.subarray(
                        offset,
                        Math.min(offset + CHUNK_BYTES, blob.bytes.byteLength),
                    ) as unknown as ArrayBuffer,
                );
            }
        } catch {
            return; // channel died mid-transfer; receiver discards partial
        }
        sendControl(channel, { k: "end", id });
    };

    /** One transfer at a time per channel — keeps the state machine trivial. */
    const enqueueServe = (channel: RTCDataChannel, id: string) => {
        const prev = serveQueues.get(channel) ?? Promise.resolve();
        const next = prev.then(() => serve(channel, id)).catch(() => {});
        serveQueues.set(channel, next);
    };

    const markMiss = (channel: RTCDataChannel, id: string) => {
        const entry = pending.get(id);
        if (!entry) return;
        entry.outstanding.delete(channel);
        if (entry.outstanding.size === 0) settle(id, null);
    };

    const handleControl = (channel: RTCDataChannel, frame: ControlFrame) => {
        switch (frame.k) {
            case "req":
                enqueueServe(channel, frame.id);
                return;
            case "miss":
                markMiss(channel, frame.id);
                return;
            case "meta": {
                log(
                    `meta ${frame.id} size=${frame.size} ` +
                        `pendingHas=${pending.has(frame.id)}`,
                );
                const entry = pending.get(frame.id);
                if (
                    !entry ||
                    frame.size <= 0 ||
                    frame.size > MAX_SERVE_BYTES
                ) {
                    incoming.set(channel, null);
                    return;
                }
                // Transfer started — stop the clock. The timeout guards
                // against nobody answering; a fetch queued behind a large
                // transfer on the same channel must not starve. Channel
                // close/churn handling below covers a sender dying mid-way.
                clearTimeout(entry.timer);
                incoming.set(channel, {
                    id: frame.id,
                    mime: frame.mime,
                    size: frame.size,
                    bytes: new Uint8Array(frame.size),
                    offset: 0,
                });
                return;
            }
            case "end": {
                const transfer = incoming.get(channel);
                log(
                    `end ${frame.id} got=${transfer?.offset ?? "-"}` +
                        `/${transfer?.size ?? "-"}`,
                );
                incoming.set(channel, null);
                if (
                    transfer &&
                    transfer.id === frame.id &&
                    transfer.offset === transfer.size
                ) {
                    settle(frame.id, {
                        bytes: transfer.bytes,
                        mimeType: transfer.mime,
                    });
                }
                return;
            }
            default:
                return;
        }
    };

    const handleChunk = (channel: RTCDataChannel, data: ArrayBuffer) => {
        const transfer = incoming.get(channel);
        if (!transfer) return;
        const chunk = new Uint8Array(data);
        if (transfer.offset + chunk.byteLength > transfer.size) {
            incoming.set(channel, null); // oversize -> discard transfer
            return;
        }
        transfer.bytes.set(chunk, transfer.offset);
        transfer.offset += chunk.byteLength;
    };

    const unsubChannels = source.onBlobChannel((peerId, channel) => {
        if (disposed) return;
        // Defense in depth: never double-subscribe the same channel (a
        // duplicate listener would double-count chunks and corrupt
        // transfers).
        if (incoming.has(channel)) return;
        log(`channel open peer=${peerId} pending=${pending.size}`);
        channel.bufferedAmountLowThreshold = BUFFER_LOW;
        channels.set(peerId, channel);
        incoming.set(channel, null);
        channel.addEventListener("message", (event: MessageEvent) => {
            if (typeof event.data === "string") {
                try {
                    handleControl(channel, JSON.parse(event.data));
                } catch {
                    // malformed frame — ignore
                }
            } else if (event.data instanceof ArrayBuffer) {
                handleChunk(channel, event.data);
            }
        });
        channel.addEventListener("close", () => {
            if (channels.get(peerId) === channel) channels.delete(peerId);
            incoming.delete(channel);
            serveQueues.delete(channel);
            for (const [id, entry] of pending) {
                if (!entry.outstanding.delete(channel)) continue;
                if (entry.outstanding.size > 0) continue;
                // A closing channel is NOT a miss — links churn (reloads,
                // re-offers) while a transfer is in flight. Re-ask every
                // surviving channel and keep the fetch pending; only an
                // explicit miss from every peer (or the timeout) settles
                // null.
                log(`channel churn, re-asking for ${id}`);
                for (const other of channels.values()) {
                    if (other.readyState !== "open") continue;
                    entry.outstanding.add(other);
                    sendControl(other, { k: "req", id });
                }
            }
        });
        // A late-joining peer may be the only holder — ask it about every
        // fetch still in flight.
        for (const [id, entry] of pending) {
            entry.outstanding.add(channel);
            sendControl(channel, { k: "req", id });
        }
    });

    return {
        fetch: (id, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) => {
            if (disposed) return Promise.resolve(null);
            const existing = pending.get(id);
            if (existing) return existing.promise; // dedupe concurrent fetches
            let resolve!: Pending["resolve"];
            const promise = new Promise<{
                bytes: Uint8Array;
                mimeType: string;
            } | null>((r) => {
                resolve = r;
            });
            const entry: Pending = {
                promise,
                resolve,
                timer: setTimeout(() => settle(id, null), timeoutMs),
                outstanding: new Set(),
            };
            pending.set(id, entry);
            let asked = 0;
            for (const channel of channels.values()) {
                if (channel.readyState !== "open") continue;
                entry.outstanding.add(channel);
                sendControl(channel, { k: "req", id });
                asked += 1;
            }
            // Nobody reachable right now: keep pending — onBlobChannel
            // re-asks when a peer connects; the timeout is the backstop.
            log(`fetch ${id} asked=${asked}/${channels.size}`);
            return promise;
        },
        dispose: () => {
            disposed = true;
            unsubChannels();
            for (const id of [...pending.keys()]) settle(id, null);
            channels.clear();
            incoming.clear();
            serveQueues.clear();
        },
    };
};
