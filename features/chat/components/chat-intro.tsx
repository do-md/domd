"use client";

export function ChatIntro() {
    return (
        <div className="flex flex-col gap-3">
            <div>
                <h1 className="text-xl font-semibold">
                    A Markdown-native chat input
                </h1>
                <p className="mt-1 text-sm text-base-content/60 max-w-2xl">
                    The star here is the input box below — a Markdown-native
                    field that renders live as you type. Write prompts with
                    WYSIWYG editing: press Enter to send, Shift+Enter for a
                    newline.
                </p>
            </div>
        </div>
    );
}

// Lightweight placeholder shown while the conversation is empty.
export function EmptyState({ onTryExample }: { onTryExample: () => void }) {
    return (
        <div className="rounded-xl border border-dashed border-base-300 px-5 py-6 text-sm text-base-content/60 flex flex-col gap-3 items-start">
            <div>
                <p className="font-medium text-base-content/80">Try asking:</p>
                <p className="mt-1">
                    “Show me a Markdown table and a TypeScript code block.”
                </p>
                <p className="mt-2 text-xs text-base-content/40">
                    No API key is required. Mock streaming is enabled by
                    default.
                </p>
            </div>
            <button
                type="button"
                onClick={onTryExample}
                className="btn btn-sm btn-neutral"
            >
                Try example
            </button>
        </div>
    );
}
