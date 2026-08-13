/**
 * Floating-panel placement relative to an anchor rect (viewport coords) with
 * edge avoidance, so the panel stays fully visible even when the anchor sits
 * near a window edge. Adapted from the reading-selection popover in
 * apps/claude-os (features/reading/select/panel-position.ts), simplified for
 * a caret-anchored popover:
 *
 *   1) flip  — prefer opening below the caret line; open above when the
 *              space below cannot fit the panel; when neither side fits,
 *              pick the taller side.
 *   2) shift — align the panel's left edge with the caret x (mention-menu
 *              convention), then clamp into the viewport with a margin.
 *   3) clamp — report the chosen side's available height as maxHeight; the
 *              caller sets maxHeight + overflow so long content scrolls
 *              inside the panel instead of spilling off screen.
 */

export interface AnchorRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export type Placement = "top" | "bottom";

export interface PanelPosition {
    left: number;
    top: number;
    placement: Placement;
    /** Available height on the chosen side; the panel should set maxHeight
     *  and scroll internally when its content is taller. */
    maxHeight: number;
}

export interface PositionOptions {
    /** Blank kept between the panel and the viewport edges. */
    margin?: number;
    /** Blank kept between the panel and the anchor (caret line). */
    gap?: number;
    viewportWidth?: number;
    viewportHeight?: number;
}

export const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), Math.max(lo, hi));

export function computePanelPosition(
    anchor: AnchorRect,
    panelWidth: number,
    panelHeight: number,
    opts: PositionOptions = {},
): PanelPosition {
    const margin = opts.margin ?? 8;
    const gap = opts.gap ?? 6;
    const vw = opts.viewportWidth ?? window.innerWidth;
    const vh = opts.viewportHeight ?? window.innerHeight;

    // flip: below the caret line by default; above when below cannot fit;
    // neither fits -> the taller side (maxHeight caps the panel there).
    const spaceDown = vh - anchor.bottom - gap - margin;
    const spaceUp = anchor.top - gap - margin;
    let placement: Placement;
    if (panelHeight <= spaceDown) placement = "bottom";
    else if (panelHeight <= spaceUp) placement = "top";
    else placement = spaceDown >= spaceUp ? "bottom" : "top";

    const maxHeight = Math.max(
        placement === "bottom" ? spaceDown : spaceUp,
        64,
    );
    const usedHeight = Math.min(panelHeight, maxHeight);

    let top =
        placement === "bottom"
            ? anchor.bottom + gap
            : anchor.top - gap - usedHeight;
    top = clamp(top, margin, vh - usedHeight - margin);

    // shift: left edge on the caret x, clamped into the viewport.
    const left = clamp(anchor.left, margin, vw - panelWidth - margin);

    return { left, top, placement, maxHeight };
}
