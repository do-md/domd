"use client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    CHUNK_BOUND_HARD_MAX,
    CHUNK_DEFAULT_MAX,
    CHUNK_DEFAULT_MIN,
    CHUNK_MIN_BOUND,
    SPEED_DELAY,
    SPEED_LABEL,
    type SpeedPreset,
    type StreamStatus,
} from "../lib/types";
import { SAMPLE_DOCS } from "../lib/sample-docs";
import type { StreamMetrics } from "./stream-driver";

export type ControlPanelProps = {
    docId: string;
    onDocChange: (id: string) => void;
    droppedDoc: { name: string; text: string } | null;
    droppedDocId: string;
    chunkBound: number;
    onChunkBoundChange: (n: number) => void;
    minChunk: number;
    maxChunk: number;
    onChunkRangeChange: (min: number, max: number) => void;
    speed: SpeedPreset;
    onSpeedChange: (s: SpeedPreset) => void;
    status: StreamStatus;
    metrics: StreamMetrics;
    onStart: () => void;
    onStop: () => void;
    onClear: () => void;
    onApply?: () => void; // mobile only — close the modal
};

function BoundEditor({
    value,
    onChange,
}: {
    value: number;
    onChange: (n: number) => void;
}) {
    const { t } = useTranslation();
    // `editing` holds the draft string when active, or null when displaying.
    // Keeping the draft inside this state (instead of a separate setState in
    // an effect) means we never need to sync it with `value`.
    const [editing, setEditing] = useState<string | null>(null);

    const commit = (draft: string) => {
        const n = Number(draft);
        if (Number.isFinite(n) && n >= CHUNK_MIN_BOUND) onChange(n);
        setEditing(null);
    };

    if (editing !== null) {
        return (
            <input
                type="number"
                autoFocus
                value={editing}
                min={CHUNK_MIN_BOUND}
                max={CHUNK_BOUND_HARD_MAX}
                onChange={(e) => setEditing(e.target.value)}
                onBlur={() => commit(editing)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit(editing);
                    else if (e.key === "Escape") setEditing(null);
                }}
                className="input input-xs h-5 w-16 px-1 text-[10px] font-mono text-right"
                aria-label={t("playground.boundEditorAria")}
            />
        );
    }

    return (
        <button
            type="button"
            onClick={() => setEditing(String(value))}
            className="link link-hover font-mono"
            title={t("playground.boundEditorTitle")}
        >
            ≤ {value}
        </button>
    );
}

function DualRange({
    min,
    max,
    valueMin,
    valueMax,
    onChange,
}: {
    min: number;
    max: number;
    valueMin: number;
    valueMax: number;
    onChange: (lo: number, hi: number) => void;
}) {
    const { t } = useTranslation();
    const span = max - min || 1;
    const loFrac = (valueMin - min) / span;
    const hiFrac = (valueMax - min) / span;
    return (
        <div className="relative h-5 px-[7px]">
            {/* full track */}
            <div className="absolute inset-x-[7px] top-1/2 -translate-y-1/2 h-1 rounded-full bg-base-300" />
            {/* selected segment — thumb is 14px, so center moves over (100% - 14px) */}
            <div
                className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full bg-base-content/80"
                style={{
                    left: `calc(7px + ${loFrac} * (100% - 14px))`,
                    right: `calc(7px + ${1 - hiFrac} * (100% - 14px))`,
                }}
            />
            <input
                type="range"
                className="dual-range"
                aria-label={t("playground.minChunkAria")}
                min={min}
                max={max}
                step={1}
                value={valueMin}
                onChange={(e) => {
                    const lo = Math.min(Number(e.target.value), valueMax);
                    onChange(lo, valueMax);
                }}
                style={{ zIndex: loFrac > 0.5 ? 4 : 3 }}
            />
            <input
                type="range"
                className="dual-range"
                aria-label={t("playground.maxChunkAria")}
                min={min}
                max={max}
                step={1}
                value={valueMax}
                onChange={(e) => {
                    const hi = Math.max(Number(e.target.value), valueMin);
                    onChange(valueMin, hi);
                }}
                style={{ zIndex: hiFrac < 0.5 ? 4 : 3 }}
            />
        </div>
    );
}

function StatusBadge({ status }: { status: StreamStatus }) {
    const { t } = useTranslation();
    const map: Record<StreamStatus, { label: string; cls: string }> = {
        idle: { label: t("playground.statusIdle"), cls: "badge-ghost" },
        streaming: {
            label: t("playground.statusStreaming"),
            cls: "badge-accent animate-pulse",
        },
        done: { label: t("playground.statusDone"), cls: "badge-success" },
        stopped: { label: t("playground.statusStopped"), cls: "badge-warning" },
    };
    const { label, cls } = map[status];
    return <span className={`badge badge-sm ${cls}`}>{label}</span>;
}

export function ControlPanel({
    docId,
    onDocChange,
    droppedDoc,
    droppedDocId,
    chunkBound,
    onChunkBoundChange,
    minChunk,
    maxChunk,
    onChunkRangeChange,
    speed,
    onSpeedChange,
    status,
    metrics,
    onStart,
    onStop,
    onClear,
    onApply,
}: ControlPanelProps) {
    const { t } = useTranslation();
    const isStreaming = status === "streaming";
    const isDropped = docId === droppedDocId && droppedDoc !== null;
    const doc = SAMPLE_DOCS.find((d) => d.id === docId) ?? SAMPLE_DOCS[0];
    const docDescription = isDropped
        ? t("playground.droppedFile", {
              count: droppedDoc!.text.length.toLocaleString(),
          })
        : doc.description;

    return (
        <div className="flex flex-col h-full min-h-0 w-full text-sm">
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 px-5 pt-5 pb-4">
            <div>
                <div className="text-base font-semibold mb-1">
                    {t("playground.panelTitle")}
                </div>
                <p className="text-xs text-base-content/60 leading-relaxed">
                    {t("playground.panelDesc")}
                </p>
            </div>

            <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-base-content/50">
                    {t("playground.status")}
                </span>
                <StatusBadge status={status} />
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-xs uppercase tracking-wide text-base-content/50">
                    {t("playground.document")}
                </label>
                <select
                    className="select select-sm select-bordered w-full"
                    value={docId}
                    onChange={(e) => onDocChange(e.target.value)}
                >
                    {droppedDoc ? (
                        <option value={droppedDocId}>
                            {droppedDoc.name} ({t("playground.dropped")})
                        </option>
                    ) : null}
                    {SAMPLE_DOCS.map((d) => (
                        <option key={d.id} value={d.id}>
                            {d.label}
                        </option>
                    ))}
                </select>
                <p className="text-xs text-base-content/60 leading-snug">
                    {docDescription}
                </p>
                {!droppedDoc ? (
                    <p className="text-[11px] text-base-content/50 leading-snug">
                        {t("playground.tip")}
                    </p>
                ) : null}
            </div>

            <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                    <label className="text-xs uppercase tracking-wide text-base-content/50">
                        {t("playground.chunkSize")}
                    </label>
                    <span className="text-xs font-mono text-base-content/70">
                        {minChunk === maxChunk
                            ? t("playground.chunkSingle", {
                                  count: minChunk,
                                  unit:
                                      minChunk === 1
                                          ? t("playground.char")
                                          : t("playground.chars"),
                              })
                            : t("playground.chunkRange", {
                                  min: minChunk,
                                  max: maxChunk,
                              })}
                        {minChunk === CHUNK_DEFAULT_MIN &&
                        maxChunk === CHUNK_DEFAULT_MAX
                            ? t("playground.aiSuffix")
                            : ""}
                    </span>
                </div>
                <DualRange
                    min={CHUNK_MIN_BOUND}
                    max={chunkBound}
                    valueMin={minChunk}
                    valueMax={maxChunk}
                    onChange={onChunkRangeChange}
                />
                <div className="flex justify-between items-center text-[10px] text-base-content/50 px-0.5">
                    <button
                        type="button"
                        onClick={() =>
                            onChunkRangeChange(CHUNK_MIN_BOUND, maxChunk)
                        }
                        className="link link-hover"
                        title={t("playground.snapMin", { value: CHUNK_MIN_BOUND })}
                    >
                        {CHUNK_MIN_BOUND}
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            onChunkRangeChange(
                                CHUNK_DEFAULT_MIN,
                                CHUNK_DEFAULT_MAX,
                            )
                        }
                        className="link link-hover"
                        title={t("playground.resetAiDefault", {
                            min: CHUNK_DEFAULT_MIN,
                            max: CHUNK_DEFAULT_MAX,
                        })}
                    >
                        {t("playground.aiDefault", {
                            min: CHUNK_DEFAULT_MIN,
                            max: CHUNK_DEFAULT_MAX,
                        })}
                    </button>
                    <BoundEditor
                        value={chunkBound}
                        onChange={onChunkBoundChange}
                    />
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-xs uppercase tracking-wide text-base-content/50">
                    {t("playground.speed")}
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                    {(Object.keys(SPEED_LABEL) as SpeedPreset[]).map(
                        (s, i, arr) => {
                            const isOddLast =
                                arr.length % 2 === 1 && i === arr.length - 1;
                            return (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => onSpeedChange(s)}
                                    className={`btn btn-xs gap-1 ${
                                        speed === s
                                            ? "btn-neutral"
                                            : "btn-ghost border border-base-300"
                                    } ${isOddLast ? "col-span-2" : ""}`}
                                >
                                    {s === "instant" ? "🚀 " : ""}
                                    {t(`playground.speedLabels.${s}`)}
                                </button>
                            );
                        },
                    )}
                </div>
                <p className="text-xs text-base-content/60">
                    {SPEED_DELAY[speed][1] === 0
                        ? t("playground.noDelay")
                        : t("playground.delayBetween", {
                              min: SPEED_DELAY[speed][0],
                              max: SPEED_DELAY[speed][1],
                          })}
                </p>
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-xs uppercase tracking-wide text-base-content/50">
                    {t("playground.metrics")}
                </label>
                <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-base-200 rounded-md py-2">
                        <div className="text-[10px] text-base-content/50 uppercase">
                            {t("playground.metricChars")}
                        </div>
                        <div className="font-mono text-xs">
                            {metrics.chars.toLocaleString()}
                        </div>
                    </div>
                    <div className="bg-base-200 rounded-md py-2">
                        <div className="text-[10px] text-base-content/50 uppercase">
                            {t("playground.metricChunks")}
                        </div>
                        <div className="font-mono text-xs">
                            {metrics.chunks.toLocaleString()}
                        </div>
                    </div>
                    <div className="bg-base-200 rounded-md py-2">
                        <div className="text-[10px] text-base-content/50 uppercase">
                            {t("playground.metricElapsed")}
                        </div>
                        <div className="font-mono text-xs">
                            {(metrics.elapsedMs / 1000).toFixed(1)}s
                        </div>
                    </div>
                </div>
            </div>

            <div className="text-[11px] text-base-content/50 leading-relaxed border-t border-base-300 pt-3">
                {t("playground.coreNote")}
            </div>
            </div>

            <div className="shrink-0 flex flex-col gap-2 px-5 py-3 border-t border-base-300">
                {isStreaming ? (
                    <button
                        type="button"
                        onClick={() => {
                            onStop();
                            onApply?.();
                        }}
                        className="btn btn-sm btn-warning"
                    >
                        {t("playground.stopStreaming")}
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => {
                            onStart();
                            onApply?.();
                        }}
                        className="btn btn-sm btn-neutral"
                    >
                        {status === "done" || status === "stopped"
                            ? t("playground.restartStreaming")
                            : t("playground.startStreaming")}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onClear}
                    disabled={isStreaming}
                    className="btn btn-sm btn-ghost"
                >
                    {t("playground.clearEditor")}
                </button>
            </div>
        </div>
    );
}
