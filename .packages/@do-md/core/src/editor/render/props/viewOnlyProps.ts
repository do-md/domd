import { DATA_VIEW_ONLY } from "../../../data-parse/constant";

/**
 * Ready-made prop bag for VIEW-ONLY decoration elements inside inline-rule
 * `component` renders (badges, icons, chrome). Spread it on every decoration
 * that is not part of the document text:
 *
 *     <span {...viewOnlyProps} className="badge">@</span>
 *
 * It marks the element with DATA_VIEW_ONLY (the whole subtree becomes
 * invisible to DOM→model text extraction and cursor offset math — without it
 * a text-bearing decoration is read back as typed input and duplicates on
 * every reparse), plus contentEditable=false (no caret inside) and
 * aria-hidden (decoration, not content).
 *
 * The key names are React-flavoured (camelCase contentEditable) — that is part
 * of the public API contract; when a second framework is supported, that
 * framework's adapter layer translates the key names, and nothing changes
 * here.
 */
export const viewOnlyProps = {
    [DATA_VIEW_ONLY]: "true",
    contentEditable: false,
    "aria-hidden": true,
} as const;
