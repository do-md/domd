"use client";
import { useEffect, useRef, useState } from "react";
import { DOMD, DOMDProvider } from "@do-md/react";
import "@do-md/react/style.css";
import { tokenize } from "@/common/lib/prism";
import type { ChatMessage } from "../lib/types";

// Collapsed user bubbles cap at this height; taller content gets an Expand
// toggle so a long pasted prompt doesn't dominate the thread.
const COLLAPSED_MAX_PX = 240;

// User message rendered through DOMD too — same Markdown surface as the input
// and the assistant output, showing input/output parity.
export function UserMessage({ message }: { message: ChatMessage }) {
    const contentRef = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);

    // Measure once after mount: when collapsed the content is clipped to
    // COLLAPSED_MAX_PX, so a scrollHeight beyond that means there's more to show.
    useEffect(() => {
        const el = contentRef.current;
        if (!el) return;
        setOverflowing(el.scrollHeight > COLLAPSED_MAX_PX + 4);
    }, []);

    return (
        <div className="flex flex-col items-end gap-1.5">
            <span className="text-xs font-semibold text-base-content/70 pr-1">
                You
            </span>
            <div className="max-w-[85%] rounded-xl bg-accent/10 border border-accent px-4 py-2.5">
                <div
                    ref={contentRef}
                    className={`overflow-hidden ${
                        expanded ? "" : "max-h-60"
                    }`}
                >
                    <DOMDProvider
                        editable={false}
                        initMd={message.markdown}
                        codeTokenizer={tokenize}
                    >
                        <DOMD />
                    </DOMDProvider>
                </div>

                {overflowing ? (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="btn btn-ghost btn-xs mt-1 -mb-1 text-base-content/60 gap-1"
                    >
                        {expanded ? "Collapse" : "Expand"}
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`w-3 h-3 transition-transform ${
                                expanded ? "rotate-180" : ""
                            }`}
                        >
                            <path d="m6 9 6 6 6-6" />
                        </svg>
                    </button>
                ) : null}
            </div>
        </div>
    );
}
