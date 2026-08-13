"use client";
/**
 * App-level inline syntax rules — documents every inlineRules v2 capability.
 *
 * NOTE: only rule 1 (`==` highlight) ships enabled in the editor for now.
 * Rules 2-6 and the shared variants below are kept as documented,
 * ready-to-enable examples — a dedicated plugin playground will exercise
 * the full set so the main editor stays lean.
 *
 * KEY DESIGN POINT — syntax and semantics are orthogonal:
 * components bind to VARIANTS (semantic types), variants are plain data
 * attached to whichever delimiters you like. Below, the same `mention` /
 * `comment` variants (with their components) are shared by BOTH the `==`
 * rule and the `<` rule, so these are equivalent:
 *
 *       =={.mention id=11}Alice==
 *       <{.mention id=11}Alice>
 *
 * Nothing about any delimiter is special-cased to a component.
 *
 * Coverage map (paste-ready test lines in each comment):
 *
 *  1. `==` upgraded in place: default highlight + positional-param styling +
 *     variants (incl. component-rendered ones) on the same delimiter.
 *       ==plain highlight==
 *       =={red}positional param styling==
 *       =={.comment author="Alice" content="comment body" date=2026-07-31}text==
 *       =={.mention id=11}Alice==
 *       =={.raw}**not bold** (parseInner off via variant)==
 *       =={.warn}unregistered variant → class degrade==
 *       =={#anchor1}id param lands as DOM id==
 *  2. `^sup^` / `~sub~` — run rules, exactLen, no spaces (`~~del~~` intact).
 *       E = mc^2^ and H~2~O but ~~strike~~ still works
 *  3. `%%` — positional param through the `{}` placeholder.
 *       %%{orange}positional tint%% and %%no param%%
 *  4. `((` `))` — asymmetric open/close pair.
 *       ((inserted text))
 *  5. `[[wikilink]]` — reserved `[` unlocked by longest-prefix precedence;
 *     `[links](…)` / `![images](…)` are untouched.
 *       [[note name]] vs [real link](https://example.com)
 *  6. `<{…}…>` — reserved `<` unlocked by capture disambiguation, carrying
 *     the SAME shared variants. `<https://x.com>` autolinks and
 *     `<u>inline html</u>` keep parsing.
 *       Ping <{.mention id=11}Alice> about <{.comment author=w}this>
 *
 * Peers in a collab session must share this same set (same contract as
 * codeTokenizer) — it lives in one module for exactly that reason.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
    InlineRule,
    InlineRuleComponentProps,
    InlineRuleParams,
    InlineRuleVariant,
} from "@do-md/core-react";
import { viewOnlyProps } from "@do-md/core-react";

/**
 * Component render channel — hard contract honored in both components:
 * domProps spread on the root, children rendered verbatim. Everything else
 * (badges, onClick, tooltips) is app business.
 */
function MentionSpan({ domProps, children, params }: InlineRuleComponentProps) {
    const id = params.named.id;
    return (
        <span
            {...domProps}
            title={id ? `mention #${id}` : undefined}
            onClick={() => {
                // Visible feedback for manual testing — check the console.
                console.log("[inline-rules demo] mention clicked:", {
                    id,
                    params,
                });
            }}
        >
            <span {...viewOnlyProps} className="mention-badge">
                @
            </span>
            {children}
        </span>
    );
}

/**
 * Anchored comment card. Rendered through a PORTAL to document.body — it
 * never enters the editor's contentEditable DOM, so no view-only marker is
 * needed and the caret/selection machinery never sees it.
 *
 * Interactions: click-outside and Escape close it; any scroll/resize closes
 * it too (cheaper and calmer than live re-anchoring); position is clamped to
 * the viewport.
 */
function CommentPopover({
    anchor,
    params,
    onClose,
}: {
    anchor: HTMLElement;
    params: InlineRuleParams;
    onClose: () => void;
}) {
    const popRef = useRef<HTMLDivElement | null>(null);
    // Measured once on mount — the popover remounts on every open (it is
    // conditionally rendered), so a lazy initializer is exactly the right
    // timing and avoids a setState-in-effect cascade.
    const [pos] = useState(() => {
        const WIDTH = 288; // w-72
        const rect = anchor.getBoundingClientRect();
        return {
            top: rect.bottom + 6,
            left: Math.min(
                Math.max(8, rect.left),
                window.innerWidth - WIDTH - 8,
            ),
        };
    });

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            // Clicks inside the card or on the anchor span itself don't
            // close (the anchor's own onClick toggles instead).
            if (popRef.current?.contains(t) || anchor.contains(t)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        window.addEventListener("scroll", onClose, true);
        window.addEventListener("resize", onClose);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
            window.removeEventListener("scroll", onClose, true);
            window.removeEventListener("resize", onClose);
        };
    }, [anchor, onClose]);

    const author = params.named.author || "Anonymous";
    const content = params.named.content;
    const date = params.named.date;
    const extras = Object.entries(params.named).filter(
        ([k]) => k !== "author" && k !== "content" && k !== "date",
    );

    return createPortal(
        <div
            ref={popRef}
            className="fixed z-50 w-72 rounded-xl border border-base-content/15 bg-base-100 shadow-xl text-base-content"
            style={{ top: pos.top, left: pos.left }}
        >
            <div className="flex items-center gap-2 px-3 pt-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/30 text-[11px] font-semibold uppercase">
                    {author.trim().charAt(0) || "?"}
                </span>
                <span className="min-w-0 truncate text-[13px] font-medium">
                    {author}
                </span>
                {date ? (
                    <span className="ml-auto shrink-0 text-[11px] text-base-content/45">
                        {date}
                    </span>
                ) : null}
            </div>
            <div className="px-3 py-2 text-[13px] leading-relaxed">
                {content ? (
                    content
                ) : (
                    <span className="italic text-base-content/45">
                        No content — write{" "}
                        <code className="text-[11px]">
                            content=&quot;…&quot;
                        </code>{" "}
                        in the {"{…}"} params.
                    </span>
                )}
            </div>
            {extras.length ? (
                <div className="flex flex-wrap gap-1 border-t border-base-300/60 px-3 py-1.5">
                    {extras.map(([k, v]) => (
                        <span
                            key={k}
                            className="rounded bg-base-200 px-1.5 py-0.5 text-[10px] text-base-content/60"
                        >
                            {k}={v}
                        </span>
                    ))}
                </div>
            ) : null}
        </div>,
        document.body,
    );
}

/**
 * Variant-level component with full interaction: click the commented text to
 * open an anchored comment card. Hard contract honored: domProps spread on
 * the root (className merged, never clobbered), children rendered verbatim,
 * decorations carry viewOnlyProps. Uses the dispatched `tagName` from props
 * (the variant declares `q`), proving the declarative config flows through.
 *
 * Params convention:
 *   =={.comment author="Alice" content="comment body" date=2026-07-31}text==
 */
function CommentSpan({
    domProps,
    children,
    params,
    tagName,
}: InlineRuleComponentProps) {
    const Tag = tagName as "span";
    // Open state doubles as the anchor: the clicked element goes into state
    // (no ref-during-render), null = closed.
    const [anchorEl, setAnchorEl] = useState<HTMLSpanElement | null>(null);

    return (
        <>
            <Tag
                {...domProps}
                className={[
                    domProps.className,
                    anchorEl ? "comment-active" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
                onClick={(e: React.MouseEvent<HTMLSpanElement>) => {
                    const el = e.currentTarget;
                    setAnchorEl((v) => (v ? null : el));
                }}
            >
                {children}
                <span {...viewOnlyProps} className="comment-badge">
                    💬
                </span>
            </Tag>
            {anchorEl ? (
                <CommentPopover
                    anchor={anchorEl}
                    params={params}
                    onClose={() => setAnchorEl(null)}
                />
            ) : null}
        </>
    );
}

/**
 * Semantic types as SHARED DATA — attach to any delimiter. The component
 * hangs off the variant, never off the syntax.
 *
 * Exported (though unused by the enabled rule set) so the upcoming plugin
 * playground can mount the full showcase without duplicating it.
 */
export const sharedVariants: Record<string, InlineRuleVariant> = {
    // {.mention id=11} → clickable pill with an @ badge
    mention: { tagName: "span", className: "mention", component: MentionSpan },
    // {.comment author="…"} → q element with a 💬 badge (component-rendered)
    comment: { tagName: "q", className: "inline-comment", component: CommentSpan },
    // {.raw} → content stays literal (no nested inline parsing)
    raw: { parseInner: false },
    color: {
        tagName: "span",
        attrs: { style: "color: color-mix(in srgb, {} 100%, transparent)" }
    },
}

export const appInlineRules: InlineRule[] = [
    // 1. The kernel's `==` highlight, upgraded in place: same syntax keeps
    //    working (and the format toolbar's highlight toggle still detects it),
    //    but now takes params and dispatches the shared variants.
    {
        open: "==",
        close: "==",
        tagName: "mark",
        attrs: {
            // =={red}text== → translucent tint; plain ==text== leaves the
            // attr voided (no positional param) and renders the default mark.
            style: "background-color: color-mix(in srgb, {} 35%, transparent)",
        },
        // variants: sharedVariants,
    },

    // 2. Superscript / subscript — exact single-char runs, no spaces.
    // {
    //     open: "^", close: "^", exactLen: true, allowSpace: false, tagName: "sup"
    // },
    // { open: "~", close: "~", exactLen: true, allowSpace: false, tagName: "sub" },

    // 3. Positional param: %%{orange}text%% — `{}` = first positional value.
    // {
    //     open: "%%",
    //     close: "%%",
    //     tagName: "mark",
    //     className: "tint",
    //     attrs: {
    //         style: "background-color: color-mix(in srgb, {} 30%, transparent)",
    //     },
    // },

    // 4. Asymmetric delimiters: ((text)) → <ins>.
    // { open: "((", close: "))", tagName: "ins" },

    // 5. Wikilink — longest-prefix unlock of the reserved `[`.
    // { open: "[[", close: "]]", tagName: "span", className: "wikilink" },

    // 6. Reserved `<` unlocked by capture disambiguation — a generic
    //    parameterized span carrying the SAME shared variants as `==`:
    //    <{.mention id=11}Alice> ≡ =={.mention id=11}Alice==.
    //    Only fires on `<{…}…>`; autolinks and inline HTML parse as before.
    // {
    //     open: "<",
    //     close: ">",
    //     tagName: "span",
    //     className: "angle-span",
    //     variants: sharedVariants,
    // },
];
