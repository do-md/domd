"use client";
/**
 * Host-side sharing UI (web /editor). Scope: STARTING a collaboration and
 * managing its invite links — nothing else. Presence and history (who is
 * online, who edited what) live in the collaboration panel
 * (versioning-panel), keeping the two entry points semantically distinct.
 * Two views:
 *  - create: optional password + expiry -> derives the room key (PBKDF2) and
 *    hands the RoomRecord up; the parent mounts CollabBridge to go live.
 *  - manage: TWO invite links (collaboration + read-only), one-click stop
 *    sharing. The read-only link (`v=1`) admits silent viewers: they receive
 *    every push but cannot edit, emit nothing, and never appear in the
 *    collaborator list.
 *
 * The password is shown once right after creation (kept only in component
 * state) — it is never persisted, only the derived non-extractable key is.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getShareOrigin, HOST_COLOR } from "../lib/config";
import {
    deriveKeyCheck,
    deriveRoomKey,
    generateClientId,
    generateLinkSecret,
    generateRoomId,
} from "../lib/crypto";
import { buildInviteUrl } from "../lib/invite";
import { putRoom } from "../lib/collab-db";
import type { RoomRecord } from "../lib/types";

type ExpiryChoice = "1h" | "24h" | "7d" | "never";

/** One labeled invite-link row with its own copy feedback. */
function InviteLinkField({ label, url }: { label: string; url: string }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard unavailable — user can select the text manually
        }
    };
    return (
        <>
            <label className="block text-xs font-medium mb-1">{label}</label>
            <div className="flex gap-2 mb-2">
                <input
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="input input-bordered input-sm flex-1 font-mono text-[11px]"
                />
                <button
                    type="button"
                    onClick={handleCopy}
                    className="btn btn-sm btn-neutral shrink-0"
                >
                    {copied ? t("collab.copied") : t("collab.copy")}
                </button>
            </div>
        </>
    );
}

const EXPIRY_SECONDS: Record<ExpiryChoice, number> = {
    "1h": 3600,
    "24h": 86400,
    "7d": 604800,
    never: 0,
};

export function ShareModal({
    room,
    onClose,
    onCreated,
    onStop,
}: {
    room: RoomRecord | null;
    onClose: () => void;
    onCreated: (room: RoomRecord) => void;
    onStop: () => void;
}) {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");
    const [expiry, setExpiry] = useState<ExpiryChoice>("24h");
    const [busy, setBusy] = useState(false);
    /** Kept only for the session that created the room (shown once). */
    const [createdPassword, setCreatedPassword] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!room) {
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }, [room]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const [editUrl, readonlyUrl] = useMemo(() => {
        if (!room) return ["", ""];
        const base = {
            roomId: room.id,
            exp: room.exp,
            keyCheck: room.keyCheck,
            linkSecret: room.linkSecret,
        };
        return [
            buildInviteUrl(getShareOrigin(), { ...base, readonly: false }),
            buildInviteUrl(getShareOrigin(), { ...base, readonly: true }),
        ];
    }, [room]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
            const roomId = generateRoomId();
            const exp =
                EXPIRY_SECONDS[expiry] === 0
                    ? 0
                    : Math.floor(Date.now() / 1000) + EXPIRY_SECONDS[expiry];
            const trimmed = password.trim();
            const linkSecret = trimmed ? null : generateLinkSecret();
            const secret = trimmed || linkSecret!;
            const [key, keyCheck] = await Promise.all([
                deriveRoomKey(secret, roomId, exp),
                deriveKeyCheck(secret, roomId, exp),
            ]);
            const now = Date.now();
            const record: RoomRecord = {
                id: roomId,
                role: "host",
                clientId: generateClientId(),
                displayName: "Host",
                color: HOST_COLOR,
                exp,
                linkSecret,
                keyCheck,
                key,
                active: 1,
                createdAt: now,
                updatedAt: now,
            };
            await putRoom(record);
            setCreatedPassword(trimmed || null);
            setPassword("");
            onCreated(record);
        } finally {
            setBusy(false);
        }
    };

    const expiryLabel = (r: RoomRecord) =>
        r.exp === 0
            ? t("collab.expiryNever")
            : new Date(r.exp * 1000).toLocaleString();

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={onClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="bg-base-100 rounded-xl shadow-xl p-6 w-[26rem] max-w-[calc(100vw-2rem)]"
            >
                {!room ? (
                    <form onSubmit={handleCreate}>
                        <h3 className="text-sm font-semibold mb-1">
                            {t("collab.createTitle")}
                        </h3>
                        <p className="text-xs text-base-content/50 mb-4">
                            {t("collab.createSubtitle")}
                        </p>
                        <label className="block text-xs font-medium mb-1">
                            {t("collab.passwordLabel")}
                        </label>
                        <input
                            ref={inputRef}
                            type="text"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t("collab.passwordPlaceholder")}
                            className="input input-bordered input-sm w-full mb-1"
                            autoComplete="off"
                        />
                        <p className="text-[11px] text-base-content/40 mb-3">
                            {t("collab.passwordHint")}
                        </p>
                        <label className="block text-xs font-medium mb-1">
                            {t("collab.expiryLabel")}
                        </label>
                        <select
                            value={expiry}
                            onChange={(e) =>
                                setExpiry(e.target.value as ExpiryChoice)
                            }
                            className="select select-bordered select-sm w-full mb-4"
                        >
                            <option value="1h">{t("collab.expiry1h")}</option>
                            <option value="24h">{t("collab.expiry24h")}</option>
                            <option value="7d">{t("collab.expiry7d")}</option>
                            <option value="never">
                                {t("collab.expiryNever")}
                            </option>
                        </select>
                        <div className="flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={onClose}
                                className="btn btn-sm btn-ghost"
                            >
                                {t("collab.cancel")}
                            </button>
                            <button
                                type="submit"
                                disabled={busy}
                                className="btn btn-sm btn-primary"
                            >
                                {busy
                                    ? t("collab.creating")
                                    : t("collab.create")}
                            </button>
                        </div>
                    </form>
                ) : (
                    <div>
                        <h3 className="text-sm font-semibold mb-1">
                            {t("collab.manageTitle")}
                        </h3>
                        <p className="text-xs text-base-content/50 mb-4">
                            {t("collab.expiresAt", {
                                when: expiryLabel(room),
                            })}
                        </p>
                        <InviteLinkField
                            label={t("collab.editLink")}
                            url={editUrl}
                        />
                        <InviteLinkField
                            label={t("collab.readonlyLink")}
                            url={readonlyUrl}
                        />
                        <p className="text-[11px] text-base-content/40 mb-3">
                            {t("collab.readonlyLinkHint")}
                        </p>
                        {createdPassword ? (
                            <p className="text-[11px] text-base-content/50 mb-3">
                                {t("collab.passwordOnce", {
                                    password: createdPassword,
                                })}
                            </p>
                        ) : room.linkSecret ? (
                            <p className="text-[11px] text-base-content/40 mb-3">
                                {t("collab.linkOnlyHint")}
                            </p>
                        ) : (
                            <p className="text-[11px] text-base-content/40 mb-3">
                                {t("collab.passwordSetHint")}
                            </p>
                        )}
                        <div className="flex justify-between items-center">
                            <button
                                type="button"
                                onClick={onStop}
                                className="btn btn-sm btn-soft btn-error"
                            >
                                {t("collab.stopSharing")}
                            </button>
                            <button
                                type="button"
                                onClick={onClose}
                                className="btn btn-sm"
                            >
                                {t("collab.done")}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
