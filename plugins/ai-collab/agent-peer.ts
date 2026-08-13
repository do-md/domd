/**
 * Wires an AI agent's own headless EditorStore to the document as a regular
 * collaborator: the agent store attaches to the session's SHARED Y.Doc as an
 * in-process peer with its own transaction origin.
 *
 *   agent ops -> applyOpToY(AGENT origin) -> the user's session observer
 *   replays them into the user store through the same op-level hot path
 *   remote peers use, and doc.on("update") broadcasts them to every
 *   connected peer for free. Inbound (user + remote) transactions replay
 *   into the agent store through translateYEvents.
 *
 * Routing agent ops through the doc (instead of into the user store
 * directly) is REQUIRED: applyExternalRenderDataOps is echo-suppressed, so
 * ops pushed straight into the user store would never reach the Y.Doc.
 *
 * There is no "no-collaboration" special case: when no room is live, the
 * host mounts a local session (attachRealtimeSync over a no-op transport),
 * so the agent is ALWAYS just a collaborator on a shared doc — same
 * authorship, history and restore semantics as any human peer.
 */
import * as Y from "yjs";
import type { CrdtCapableStore } from "../collaboration/crdt-sync/types";
import {
    ROOT_KEY,
    type Registry,
    applyOpToY,
    registerSubtree,
    yNodeToJSON,
} from "../collaboration/crdt-sync/y-mapping";
import { translateYEvents } from "../collaboration/realtime-sync/translate";

/** Transaction origin for agent-store edits pushed into the shared doc. Must
 *  differ from realtime-sync's LOCAL_ORIGIN (so the user session replays
 *  them into the user store) and REMOTE_ORIGIN (so they broadcast). */
export const AGENT_PEER_ORIGIN = "domd-ai-agent-peer";

export interface AgentPeerHandle {
    dispose(): void;
}

/** Attach the agent store to the session's shared doc as an in-process
 *  peer. Seeds the agent store from the doc (which the user's session
 *  keeps current). */
export const attachDocPeer = (
    agentStore: CrdtCapableStore,
    doc: Y.Doc,
): AgentPeerHandle => {
    const rootNode = doc.getMap<unknown>(ROOT_KEY);
    const registry: Registry = new Map();
    registerSubtree(rootNode, registry);

    // Seed: the session's doc is the source of truth (the user session
    // flushed its content in at attach time and keeps it current).
    agentStore.applyExternalRenderData(yNodeToJSON(rootNode));

    // Outbound: agent ops -> shared doc under the agent origin.
    const unsubOps = agentStore.subscribeRenderDataOps((ops) => {
        doc.transact(() => {
            for (const op of ops) applyOpToY(rootNode, op, registry);
        }, AGENT_PEER_ORIGIN);
    });

    // Inbound: every non-agent transaction (user local edits, remote peers,
    // version restores) replays into the agent store. Registry is rebuilt
    // wholesale on any change — same v1 simplification as realtime-sync.
    const onDeepEvents = (
        events: Y.YEvent<Y.AbstractType<unknown>>[],
        tx: Y.Transaction,
    ) => {
        if (tx.origin === AGENT_PEER_ORIGIN) {
            registry.clear();
            registerSubtree(rootNode, registry);
            return;
        }
        const ops = translateYEvents(events);
        registry.clear();
        registerSubtree(rootNode, registry);
        if (ops.length) void agentStore.applyExternalRenderDataOps?.(ops);
    };
    rootNode.observeDeep(onDeepEvents);

    return {
        dispose: () => {
            unsubOps();
            rootNode.unobserveDeep(onDeepEvents);
        },
    };
};
