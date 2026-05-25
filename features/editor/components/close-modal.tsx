"use client";

export function CloseModal({
    onSave,
    onDiscard,
    onCancel,
}: {
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-base-100 rounded-xl shadow-xl p-6 w-80">
                <p className="text-sm text-base-content mb-5">
                    Do you want to save changes before closing?
                </p>
                <div className="flex justify-end gap-2">
                    <button
                        onClick={onDiscard}
                        className="btn btn-sm btn-ghost text-error"
                    >
                        Don&apos;t Save
                    </button>
                    <button onClick={onCancel} className="btn btn-sm">
                        Cancel
                    </button>
                    <button
                        onClick={onSave}
                        className="btn btn-sm btn-primary"
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
