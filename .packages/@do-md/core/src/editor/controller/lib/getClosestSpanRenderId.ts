import { DATA_SPAN_RENDER_ID } from "../../../data-parse/constant";

/**
 * Nearest content-span uuid at or above a DOM node (the DATA_SPAN_RENDER_ID
 * public contract — text leaves only). Used at input-event time to identify
 * the span the browser wrote speculative input into: the caret sits inside
 * that span's text node when `handleInput_` fires. The uuid feeds the exact
 * dirty-DOM flush in `resetTextByUUID_` (see mergeStructural's bumpDomVersion
 * note); returns null when the caret is not inside a tagged span (e.g. a bare
 * text node the browser created between spans), in which case the positional
 * fallback bumps inside the merge still apply.
 */
export const getClosestSpanRenderId = (
    node: Node | null | undefined,
): string | null => {
    if (!node) return null;
    const el = node instanceof HTMLElement ? node : node.parentElement;
    return (
        el
            ?.closest(`[${DATA_SPAN_RENDER_ID}]`)
            ?.getAttribute(DATA_SPAN_RENDER_ID) ?? null
    );
};
