"use client";
/**
 * Author-colored span highlights (the UI half of ownership) — CSS-only.
 *
 * The kernel marks every CONTENT text leaf with its model uuid
 * (`data-span-render-id`, a public DOM contract with the same discipline as
 * `data-render-id` on blocks; markdown-symbol elements stay unmarked). So
 * highlighting is a pure attribute-selector stylesheet:
 *
 *   [data-span-render-id="<uuid>"] { background-color: ... }
 *
 * No measurement, no overlays, no text matching. React re-renders, span
 * merges (domVersion remounts) and speculative input all just work — the
 * attribute follows the element and the rule follows the attribute. This
 * replaced an overlay-rect approach whose block-level fallback mis-painted
 * whole paragraphs whenever a span's text failed to match uniquely.
 *
 * Span-level ONLY by design: a mis-scoped block tint reads as wrong
 * attribution, which is worse than no tint. Selectors for spans that no
 * longer exist simply match nothing.
 */
import { useMemo } from "react";

export interface HighlightTarget {
    uuid: string;
    color: string;
}

const HIGHLIGHT_ALPHA = 0.24;
/** Stylesheet budget. Beyond this the newest targets win (authorship maps
 *  accumulate dead uuids over long sessions); the cut is logged so it never
 *  reads as full coverage. */
const MAX_HIGHLIGHT_RULES = 1500;

const hexToRgba = (hex: string, alpha: number): string => {
    let h = hex.replace("#", "");
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const value = Number.parseInt(h, 16);
    if (Number.isNaN(value) || h.length !== 6) {
        return `rgba(138, 122, 168, ${alpha})`; // muted fallback
    }
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export function AuthorHighlights({
    targets,
}: {
    targets: HighlightTarget[];
}) {
    const css = useMemo(() => {
        if (targets.length === 0) return "";
        let clipped = targets;
        if (targets.length > MAX_HIGHLIGHT_RULES) {
            clipped = targets.slice(-MAX_HIGHLIGHT_RULES);
            console.warn(
                `[author-highlights] ${targets.length} targets exceed the ` +
                    `${MAX_HIGHLIGHT_RULES}-rule budget; oldest ` +
                    `${targets.length - MAX_HIGHLIGHT_RULES} dropped`,
            );
        }
        const byColor = new Map<string, string[]>();
        for (const target of clipped) {
            const selector = `[data-span-render-id="${CSS.escape(target.uuid)}"]`;
            const list = byColor.get(target.color);
            if (list) list.push(selector);
            else byColor.set(target.color, [selector]);
        }
        const rules: string[] = [];
        for (const [color, selectors] of byColor) {
            rules.push(
                `${selectors.join(",")}{background-color:${hexToRgba(color, HIGHLIGHT_ALPHA)};border-radius:2px;-webkit-box-decoration-break:clone;box-decoration-break:clone;}`,
            );
        }
        return rules.join("\n");
    }, [targets]);

    if (!css) return null;
    return <style data-domd-author-highlights="">{css}</style>;
}
