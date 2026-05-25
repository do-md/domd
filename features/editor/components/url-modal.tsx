"use client";
import { useEffect, useRef, useState } from "react";

// Mount-only: parent should render this conditionally so each open is a
// fresh instance. Lets us avoid resetting state in an effect.
export function UrlModal({
    onClose,
    onSubmit,
}: {
    onClose: () => void;
    onSubmit: (input: string) => void;
}) {
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const id = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(id);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={onClose}
        >
            <form
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                    e.preventDefault();
                    const t = value.trim();
                    if (!t) return;
                    onSubmit(t);
                    onClose();
                }}
                className="bg-base-100 rounded-xl shadow-xl p-6 w-96"
            >
                <h3 className="text-sm font-semibold mb-3">Open from URL</h3>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="URL or gh:owner/repo"
                    className="input input-bordered input-sm w-full mb-4"
                />
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="btn btn-sm btn-ghost"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!value.trim()}
                        className="btn btn-sm btn-primary"
                    >
                        Open
                    </button>
                </div>
            </form>
        </div>
    );
}
