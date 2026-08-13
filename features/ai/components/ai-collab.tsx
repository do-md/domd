"use client";
/**
 * In-provider runtime for AI collaboration:
 *
 * - Detects a "@" typed in the editor (document-level `beforeinput` capture
 *   — synchronous, so the picker appears instantly). The "@" itself types
 *   through into the document as normal text: the picker is an offer, not a
 *   mode. Focus STAYS in the document — the user keeps typing (or moves the
 *   caret, deletes the "@", hits Escape) to decline it, and the picker just
 *   goes away with the "@" left as typed. Deliberately no trigger
 *   conditions (word boundaries etc.): a conditional trigger reads as
 *   flaky ("@ sometimes works").
 * - While the picker is up (always shown, even with a single agent),
 *   ArrowUp/Down move the highlight — first agent preselected — and Enter
 *   picks, captured document-level so the editor never sees those keys;
 *   any other key dismisses the picker and flows to the editor untouched.
 *   Picking removes the just-typed "@" (offset invariant checked against
 *   toMarkdown — table cells pad alignment spaces into the serialization
 *   but not into `before` — fail-safe: leave the "@") and morphs the same
 *   popover into the composer, which then takes focus.
 * - The popover (portal — never part of the document, never synced) anchors
 *   at the caret with edge avoidance (flip/shift/clamp, adapted from the
 *   claude-os reading-selection popover), can be dragged anywhere (user
 *   placement then wins over auto-positioning); the composer dismisses
 *   when focus leaves it.
 * - Sending runs the agent
 *   (plugins/ai-collab/run-agent): a per-run headless EditorStore edits the
 *   document through the normal pipeline; the composer shows a loading send
 *   button until the first visible action, then disappears while the
 *   agent's live caret takes over as feedback.
 *
 * The agent is an ordinary collaborator on the session's shared doc — its
 * caret renders through the session's peer presence, and blame highlight /
 * history / restore all live in the collaboration panel, exactly as for
 * human peers. A session always exists while AI collaboration is enabled
 * (a live room, or the LocalAiBridge session).
 */
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { EditorStore, useEditorStoreApi } from "@do-md/core-react";
import { useTranslation } from "react-i18next";
import { tokenize } from "@/common/lib/prism";
import { useLatest } from "@/common/lib/use-latest";
import { beautify } from "@/common/lib/beautify";
import { appInlineRules } from "@/features/editor/lib/inline-rules";
import type { RealtimeSyncHandle } from "@/plugins/collaboration/realtime-sync";
import {
    runAgent,
    type AgentRunHandle,
} from "@/plugins/ai-collab/run-agent";
import type { CursorPosition } from "@/plugins/collaboration/crdt-sync/types";
import {
    CURSOR_MARKER,
    buildAgentMessages,
    buildReflectionMessage,
    completeAgentChat,
    mockAgentComplete,
    type LlmMessage,
} from "../lib/llm";
import {
    clamp,
    computePanelPosition,
    type AnchorRect,
} from "../lib/popover-position";
import { loadApiKey, saveApiKey } from "../lib/storage";
import { agentClientId, type AgentConfig } from "../lib/types";

type Phase = "idle" | "waiting" | "streaming";

interface PopoverState {
    /** Caret rect at the trigger (viewport coords). */
    anchor: AnchorRect;
    /** null = agent pick phase; set = composer phase. */
    agent: AgentConfig | null;
    needKey: boolean;
    /** Model caret captured when the agent is picked (right after the "@"
     *  removal) — where the run acts. Survives the editor losing DOM focus
     *  to the composer. Null during the pick phase. */
    invocationCursor: CursorPosition | null;
    /** The editor's contenteditable root, for refocusing on close. */
    editorEl: HTMLElement | null;
}

interface CloseOptions {
    /** Hand focus back to the editor. */
    refocus?: boolean;
}

/** Caret rect in viewport coords. A collapsed caret at a line start / in an
 *  empty block reports a zero-size rect (cross-engine quirk) — fall back to
 *  the containing element's top-left. */
const caretAnchor = (sel: Selection): AnchorRect | null => {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
        return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };
    }
    const node = range.startContainer;
    const el =
        node.nodeType === Node.ELEMENT_NODE
            ? (node as HTMLElement)
            : node.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const height = Math.min(r.height || 24, 28);
    return {
        left: r.left,
        top: r.top,
        right: r.left,
        bottom: r.top + height,
        width: 0,
        height,
    };
};

const needsKey = (agent: AgentConfig) =>
    agent.model !== "mock" && !loadApiKey(agent.provider);

/** Focus the input on mount, re-asserting for a few frames until it sticks.
 *  A single focus() can silently lose here: the popover container starts
 *  visibility:hidden until its first position measurement (an unfocusable
 *  state), and when the popover opens straight from the "@" keystroke the
 *  editor still owns focus and its post-keystroke bookkeeping can grab it
 *  back a frame later. */
function useAutoFocus(ref: React.RefObject<HTMLInputElement | null>) {
    useEffect(() => {
        let raf = 0;
        let tries = 0;
        const attempt = () => {
            const input = ref.current;
            if (!input) return;
            input.focus();
            if (document.activeElement !== input && ++tries < 10) {
                raf = requestAnimationFrame(attempt);
            }
        };
        attempt();
        return () => cancelAnimationFrame(raf);
    }, [ref]);
}

export function AiCollab({
    agents,
    enabled,
    session,
}: {
    agents: AgentConfig[];
    enabled: boolean;
    /** The collaboration session the agents ride (live room or the local
     *  no-transport session). Null only during attach transitions. */
    session: { handle: RealtimeSyncHandle } | null;
}) {
    const { t } = useTranslation();
    const store = useEditorStoreApi();

    const [popover, setPopover] = useState<PopoverState | null>(null);
    const [composerError, setComposerError] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>("idle");
    const [toast, setToast] = useState<string | null>(null);

    const phaseRef = useLatest(phase);
    const popoverRef = useLatest(popover);
    const runRef = useRef<AgentRunHandle | null>(null);
    const sessionRef = useLatest(session);

    // ---- "@" trigger: synchronous beforeinput capture (instant — no wait
    // for the caret's RAF-debounced store sync). The event is NOT prevented:
    // the "@" types into the document as normal text and the picker appears
    // alongside it, with focus staying in the document. ----
    useEffect(() => {
        if (!store || !enabled || agents.length === 0) return;
        const onBeforeInput = (event: Event) => {
            const e = event as InputEvent;
            if (e.inputType !== "insertText" || e.data !== "@") return;
            if (phaseRef.current !== "idle" || popoverRef.current) return;
            const editorEl = (e.target as HTMLElement | null)?.closest?.(
                '[contenteditable="true"]',
            ) as HTMLElement | null;
            // Only the document editor (its blocks carry data-render-id).
            if (!editorEl?.querySelector("[data-render-id]")) return;
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
            const anchor = caretAnchor(sel);
            if (!anchor) return;
            setComposerError(null);
            setPopover({
                anchor,
                agent: null,
                needKey: false,
                invocationCursor: null,
                editorEl,
            });
        };
        document.addEventListener("beforeinput", onBeforeInput, true);
        return () =>
            document.removeEventListener("beforeinput", onBeforeInput, true);
    }, [store, enabled, agents.length, phaseRef, popoverRef]);

    const closePopover = useCallback(
        (opts?: CloseOptions) => {
            const pop = popoverRef.current;
            if (!pop) return;
            if (phaseRef.current === "waiting") {
                runRef.current?.cancel();
                setPhase("idle");
            }
            setPopover(null);
            setComposerError(null);
            if (opts?.refocus) {
                pop.editorEl?.focus({ preventScroll: true });
            }
        },
        [phaseRef, popoverRef],
    );

    // Picking an agent: flush the typing burst (Enter can arrive before the
    // "@" commits to the model), remove the just-typed "@", anchor the
    // invocation caret, then morph the popover into the composer.
    const pickAgent = useCallback(
        (agent: AgentConfig) => {
            setComposerError(null);
            const proceed = async () => {
                let invocationCursor: CursorPosition | null = null;
                if (store) {
                    try {
                        await store.flushPendingInput();
                        const sel = store.getSelectionState(1_000_000);
                        if (
                            !sel.has_selection &&
                            !sel.before_truncated &&
                            sel.before.endsWith("@")
                        ) {
                            const off = sel.before.length;
                            // `before.length` is a valid absolute offset only
                            // when the serialized prefix matches exactly
                            // (table cells pad alignment spaces into
                            // toMarkdown but not into `before`) — verify the
                            // invariant, else fail-safe: leave the "@".
                            if (
                                store.toMarkdown().slice(0, off) ===
                                sel.before
                            ) {
                                store.replaceRanges({
                                    start: off - 1,
                                    end: off,
                                    text: "",
                                });
                            }
                        }
                    } catch {
                        // Leave the "@" in place; the run still works.
                    }
                    invocationCursor =
                        store.getCursorSnapshot?.().start ?? null;
                }
                setPopover((p) =>
                    p
                        ? {
                              ...p,
                              agent,
                              needKey: needsKey(agent),
                              invocationCursor,
                          }
                        : p,
                );
            };
            void proceed();
        },
        [store],
    );

    // ---- Run ----
    const startRun = useCallback(
        (
            agent: AgentConfig,
            instruction: string,
            invocationCursor: CursorPosition | null,
        ): string => {
            if (!store || phaseRef.current !== "idle") return "busy";
            const activeSession = sessionRef.current;
            if (!activeSession) {
                setComposerError(t("ai.errors.generic"));
                return "no session";
            }
            // Single NON-STREAMING request, Aider-style SEARCH/REPLACE
            // blocks: the complete reply is parsed as a whole, then applied
            // block by block (select -> showcase -> atomic replace). Failed
            // blocks reflect back to the model for ONE corrective retry
            // (aider's reliability mechanism).
            let complete: () => Promise<string>;
            let messages: LlmMessage[] | null = null;
            let apiKey = "";
            if (agent.model === "mock") {
                complete = () => mockAgentComplete(agent.name, instruction);
            } else {
                const key = loadApiKey(agent.provider);
                if (!key) {
                    setComposerError(t("ai.errors.noKey"));
                    return "no key";
                }
                apiKey = key;
                let documentWithCursor: string;
                try {
                    const sel = store.getSelectionState(1_000_000);
                    documentWithCursor =
                        sel.before +
                        CURSOR_MARKER +
                        sel.selected_text +
                        sel.after;
                } catch {
                    documentWithCursor =
                        store.toMarkdown() + "\n" + CURSOR_MARKER;
                }
                messages = buildAgentMessages({
                    agentName: agent.name,
                    agentPrompt: agent.prompt,
                    documentWithCursor,
                    instruction,
                });
                const boundMessages = messages;
                complete = () =>
                    completeAgentChat(
                        key,
                        agent.provider,
                        agent.model,
                        boundMessages,
                    );
            }

            setPhase("waiting");
            const baseOptions = {
                createAgentStore: () =>
                    new EditorStore({
                        editable: true,
                        initMd: "",
                        codeTokenizer: tokenize,
                        inlineRules: appInlineRules,
                        codeBeautify: beautify,
                    }) as never,
                session: {
                    doc: activeSession.handle.doc,
                    handle: activeSession.handle,
                },
                identity: {
                    clientId: agentClientId(agent),
                    name: agent.name,
                    color: agent.color,
                },
                invocationCursor,
                onLocated: () => {
                    // The agent's intent (selection / caret) is now visible
                    // on every peer — the composer's job is done.
                    setPopover(null);
                    setPhase("streaming");
                },
            };
            const execute = async () => {
                // Capture the raw reply so a reflection retry can include
                // it as assistant context (aider-style).
                let capturedReply = "";
                const capturingComplete = async () => {
                    capturedReply = await complete();
                    return capturedReply;
                };
                let handle = runAgent({
                    ...baseOptions,
                    complete: capturingComplete,
                });
                runRef.current = handle;
                let summary = await handle.done;
                const retryable = summary.failures.some(
                    (f) =>
                        f.reason === "not_found" || f.reason === "malformed",
                );
                if (messages && retryable) {
                    const retryMessages: LlmMessage[] = [
                        ...messages,
                        { role: "assistant", content: capturedReply },
                        {
                            role: "user",
                            content: buildReflectionMessage(
                                summary.failures,
                                summary.applied,
                            ),
                        },
                    ];
                    handle = runAgent({
                        ...baseOptions,
                        complete: () =>
                            completeAgentChat(
                                apiKey,
                                agent.provider,
                                agent.model,
                                retryMessages,
                            ),
                    });
                    runRef.current = handle;
                    const second = await handle.done;
                    summary = {
                        mode: summary.mode,
                        applied: summary.applied + second.applied,
                        failures: second.failures,
                    };
                }
                return summary;
            };
            execute()
                .then((summary) => {
                    if (summary.failures.length > 0) {
                        const reasons = [
                            ...new Set(
                                summary.failures.map((f) => f.reason),
                            ),
                        ].join(", ");
                        const message =
                            t("ai.partialFail", {
                                count: summary.failures.length,
                            }) + ` (${reasons})`;
                        // Popover still open = the locate round failed
                        // outright (nothing became visible) — report inline
                        // so the user can adjust and resend.
                        if (popoverRef.current) setComposerError(message);
                        else setToast(message);
                    }
                })
                .catch((err: unknown) => {
                    const message =
                        err instanceof Error && err.message
                            ? err.message
                            : t("ai.errors.generic");
                    if (popoverRef.current) setComposerError(message);
                    else setToast(message);
                })
                .finally(() => {
                    runRef.current = null;
                    setPhase("idle");
                });
            return "started";
        },
        [store, t, phaseRef, popoverRef, sessionRef],
    );

    // Cancel a live run when the runtime unmounts (doc swap, page leave).
    useEffect(() => () => runRef.current?.cancel(), []);

    // Toast auto-dismiss.
    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
    }, [toast]);

    // Debug/automation hook (same family as window.insertText): run an agent
    // without the pointer flow — `window.__domdAiRun(0, "s/foo/bar/")`.
    useEffect(() => {
        // @ts-expect-error debug surface
        window.__domdAiRun = (agentIndex: number, instruction: string) => {
            const agent = agents[agentIndex];
            if (!agent || !store) return "no agent or store";
            const cursor = store.getCursorSnapshot?.().start ?? null;
            return startRun(agent, instruction, cursor);
        };
        return () => {
            // @ts-expect-error debug surface
            delete window.__domdAiRun;
        };
    }, [agents, store, startRun]);

    if (!store) return null;

    return (
        <>
            {popover ? (
                <AgentPopover
                    agents={agents}
                    agent={popover.agent}
                    anchor={popover.anchor}
                    needKey={popover.needKey}
                    waiting={phase === "waiting"}
                    error={composerError}
                    onPick={pickAgent}
                    onSend={(instruction, keyInput) => {
                        const agent = popover.agent;
                        if (!agent) return;
                        if (keyInput) saveApiKey(agent.provider, keyInput);
                        setComposerError(null);
                        startRun(agent, instruction, popover.invocationCursor);
                    }}
                    onClose={closePopover}
                />
            ) : null}

            {toast
                ? createPortal(
                      <div className="toast toast-center z-[70]">
                          <div className="alert alert-warning py-2 text-xs">
                              {toast}
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}

/**
 * The "@" popover: one draggable, edge-avoiding container that hosts the
 * agent pick phase and then morphs into the composer (keeping any position
 * the user dragged it to). Auto-focuses its input; dismisses when focus
 * leaves it or on an outside pointerdown — except while a run is waiting,
 * where only Escape (cancel) or completion closes it.
 */
function AgentPopover({
    agents,
    agent,
    anchor,
    needKey,
    waiting,
    error,
    onPick,
    onSend,
    onClose,
}: {
    agents: AgentConfig[];
    agent: AgentConfig | null;
    anchor: AnchorRect;
    needKey: boolean;
    waiting: boolean;
    error: string | null;
    onPick: (agent: AgentConfig) => void;
    onSend: (instruction: string, keyInput: string) => void;
    onClose: (opts?: CloseOptions) => void;
}) {
    const elRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{
        left: number;
        top: number;
        maxHeight: number;
    } | null>(null);
    const [dragged, setDragged] = useState<{
        left: number;
        top: number;
    } | null>(null);
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        baseLeft: number;
        baseTop: number;
    } | null>(null);
    const draggedRef = useLatest(dragged);
    const waitingRef = useLatest(waiting);

    const reposition = useCallback(() => {
        if (draggedRef.current) return; // user placement wins
        const el = elRef.current;
        if (!el) return;
        const p = computePanelPosition(
            anchor,
            el.offsetWidth,
            el.offsetHeight,
        );
        setPos({ left: p.left, top: p.top, maxHeight: p.maxHeight });
    }, [anchor, draggedRef]);

    // Measure + position on mount and on phase change (pick -> composer
    // resizes the panel); ResizeObserver covers content growth (error rows,
    // API key input), window resize re-clamps.
    useLayoutEffect(() => {
        reposition();
    }, [reposition, agent]);

    useEffect(() => {
        const el = elRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => reposition());
        ro.observe(el);
        const onWin = () => reposition();
        window.addEventListener("resize", onWin);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", onWin);
        };
    }, [reposition]);

    // Outside pointerdown dismisses (focus loss below is the other path).
    useEffect(() => {
        const onDown = (e: PointerEvent) => {
            if (waitingRef.current) return;
            const el = elRef.current;
            if (!el || el.contains(e.target as Node)) return;
            onClose();
        };
        document.addEventListener("pointerdown", onDown, true);
        return () =>
            document.removeEventListener("pointerdown", onDown, true);
    }, [onClose, waitingRef]);

    // Dismiss when focus leaves the popover. Deferred a frame: moving focus
    // between the popover's own inputs (pick -> composer) must not close it,
    // and neither should the window itself losing focus (app switch).
    const onFocusOut = () => {
        if (waitingRef.current) return;
        requestAnimationFrame(() => {
            const el = elRef.current;
            if (!el || !document.hasFocus()) return;
            const active = document.activeElement;
            if (active && el.contains(active)) return;
            onClose();
        });
    };

    // ---- Drag (any non-interactive area). preventDefault keeps focus —
    // and therefore the caret — exactly where it is while dragging. ----
    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        if (
            (e.target as HTMLElement).closest(
                "input,textarea,button,select,a",
            )
        ) {
            return;
        }
        const el = elRef.current;
        const base = draggedRef.current ?? pos;
        if (!el || !base) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            baseLeft: base.left,
            baseTop: base.top,
        };
        setDragging(true);
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        const el = elRef.current;
        if (!d || !el || e.pointerId !== d.pointerId) return;
        setDragged({
            left: clamp(
                d.baseLeft + e.clientX - d.startX,
                8,
                window.innerWidth - el.offsetWidth - 8,
            ),
            top: clamp(
                d.baseTop + e.clientY - d.startY,
                8,
                window.innerHeight - el.offsetHeight - 8,
            ),
        });
    };
    const endDrag = (e: React.PointerEvent) => {
        if (dragRef.current?.pointerId !== e.pointerId) return;
        dragRef.current = null;
        setDragging(false);
    };

    const placed = dragged ?? pos;
    const maxHeight = dragged
        ? window.innerHeight - 16
        : (pos?.maxHeight ?? undefined);

    return createPortal(
        <div
            ref={elRef}
            role="dialog"
            data-ai-popover
            className={
                "fixed z-[60] max-w-[92vw] overflow-auto rounded-xl border border-base-content/15 bg-base-100 shadow-lg " +
                (dragging ? "cursor-grabbing" : "cursor-grab")
            }
            style={{
                left: placed?.left ?? -9999,
                top: placed?.top ?? -9999,
                maxHeight,
                visibility: placed ? "visible" : "hidden",
            }}
            onBlur={onFocusOut}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        >
            {agent ? (
                <ComposerPane
                    key={agent.id}
                    agent={agent}
                    needKey={needKey}
                    waiting={waiting}
                    error={error}
                    onSend={onSend}
                    onClose={onClose}
                />
            ) : (
                <PickPane agents={agents} onPick={onPick} onClose={onClose} />
            )}
        </div>,
        document.body,
    );
}

/** Agent pick list. Focus stays in the DOCUMENT the whole time — the list
 *  has no input of its own. Bare ArrowUp/Down/Enter/Escape are captured
 *  document-level (the editor never sees them); any other key — continued
 *  typing, caret movement, Backspace over the "@", shortcuts — dismisses
 *  the picker and flows to the editor untouched. */
function PickPane({
    agents,
    onPick,
    onClose,
}: {
    agents: AgentConfig[];
    onPick: (agent: AgentConfig) => void;
    onClose: (opts?: CloseOptions) => void;
}) {
    const { t } = useTranslation();
    const [index, setIndex] = useState(0);
    const indexRef = useLatest(index);
    const agentsRef = useLatest(agents);
    const activeRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: "nearest" });
    }, [index]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const bare =
                !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
            if (bare && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                e.stopPropagation();
                const list = agentsRef.current;
                if (list.length === 0) return;
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setIndex((i) => (i + delta + list.length) % list.length);
                return;
            }
            if (bare && e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                const list = agentsRef.current;
                const target = list[indexRef.current] ?? list[0];
                if (target) onPick(target);
                return;
            }
            if (bare && e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            }
            // A lone modifier press decides nothing — wait for the real key.
            if (
                ["Shift", "Meta", "Alt", "Control", "CapsLock"].includes(
                    e.key,
                )
            ) {
                return;
            }
            onClose();
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, [onPick, onClose, agentsRef, indexRef]);

    return (
        <div className="w-56 p-1">
            <div className="px-2 py-1 text-[11px] text-base-content/40">
                {t("ai.pickerTitle")}
            </div>
            {agents.map((a, i) => (
                <button
                    key={a.id}
                    ref={i === index ? activeRef : undefined}
                    className={
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm " +
                        (i === index ? "bg-base-200" : "hover:bg-base-200/60")
                    }
                    onPointerEnter={() => setIndex(i)}
                    // Keep the editor focused (no caret flicker) — the
                    // composer takes focus right after the pick anyway.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => onPick(a)}
                >
                    <span
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: a.color }}
                    />
                    <span className="truncate">{a.name}</span>
                    <span className="ml-auto truncate text-[10px] text-base-content/40">
                        {a.model}
                    </span>
                </button>
            ))}
        </div>
    );
}

function ComposerPane({
    agent,
    needKey,
    waiting,
    error,
    onSend,
    onClose,
}: {
    agent: AgentConfig;
    needKey: boolean;
    waiting: boolean;
    error: string | null;
    onSend: (instruction: string, keyInput: string) => void;
    onClose: (opts?: CloseOptions) => void;
}) {
    const { t } = useTranslation();
    const [instruction, setInstruction] = useState("");
    const [keyInput, setKeyInput] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    useAutoFocus(inputRef);

    const canSend = instruction.trim().length > 0 && !waiting;
    const submit = () => {
        if (!canSend) return;
        onSend(instruction.trim(), keyInput.trim());
    };

    return (
        <div
            className="w-96 max-w-full p-2"
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    onClose({ refocus: true });
                }
            }}
        >
            <div className="flex items-center gap-2">
                <span
                    className="badge badge-soft badge-sm shrink-0 gap-1 border-0"
                    style={{
                        backgroundColor: `color-mix(in srgb, ${agent.color} 18%, transparent)`,
                        color: agent.color,
                    }}
                >
                    @{agent.name}
                </span>
                <input
                    ref={inputRef}
                    className="input input-sm input-ghost min-w-0 flex-1 px-1 focus:outline-none"
                    placeholder={t("ai.composerPlaceholder")}
                    value={instruction}
                    disabled={waiting}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            submit();
                        }
                    }}
                />
                <button
                    className="btn btn-primary btn-xs shrink-0"
                    disabled={!canSend}
                    onClick={submit}
                >
                    {waiting ? (
                        <span className="loading loading-spinner loading-xs" />
                    ) : (
                        t("ai.send")
                    )}
                </button>
            </div>
            {needKey ? (
                <input
                    type="password"
                    className="input input-sm input-bordered mt-2 w-full"
                    placeholder={t("ai.apiKeyFor", {
                        provider: agent.provider,
                    })}
                    value={keyInput}
                    disabled={waiting}
                    onChange={(e) => setKeyInput(e.target.value)}
                />
            ) : null}
            {error ? (
                <div className="mt-1.5 px-1 text-[11px] text-error">
                    {error}
                </div>
            ) : null}
        </div>
    );
}
