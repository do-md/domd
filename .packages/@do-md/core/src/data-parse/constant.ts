export const DATA_RENDER_ID = "data-render-id";
export const DATA_ATOMIC_RENDER_ID = "data-atomic-render-id";
/** Public DOM contract for text leaves (same discipline as DATA_RENDER_ID
 *  on blocks): a content leaf's element carries its model uuid so external
 *  tooling (author highlights, sync overlays) can target it with plain CSS
 *  attribute selectors — no core internals, no text matching. Markdown
 *  symbol elements stay unmarked: they are chrome, not content. */
export const DATA_SPAN_RENDER_ID = "data-span-render-id";
/** Public DOM contract for VIEW-ONLY decoration elements (inline-rule
 *  component badges, icons, chrome). Any element carrying this attribute is
 *  invisible to the DOM→model text pipeline: text extraction skips its whole
 *  subtree and cursor offset math never counts its characters. Without the
 *  marker, a text-bearing decoration (e.g. an "@" badge) would be read back
 *  as typed input on the next reparse and duplicate forever. Hosts should
 *  spread the ready-made `viewOnlyProps` bag instead of hand-writing this. */
export const DATA_VIEW_ONLY = "data-domd-view-only";
/** Trailing-line filler <br> (the same trick as ProseMirror's
 *  trailingBreak): when a block's text ends with \n, pre-wrap generates no
 *  line box for the trailing empty line — Chrome's caret cannot get into it
 *  (a pure CSS ::after was tried and proved not to work, see
 *  reference/zwsp-to-trailing-br-plan.md). The render layer appends a <br>
 *  carrying this marker at the end of the block to prop the last line open;
 *  a <br> has no textContent, so it stays out of text extraction for free
 *  (Range.toString() does not include a br) and has zero impact on the
 *  model or on serialization. */
export const DATA_FILLER_BR = "data-domd-filler";
