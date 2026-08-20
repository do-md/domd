import {
    InlineRule,
    InlineRuleComponentProps,
    InlineRuleParams,
    RenderData,
} from "../editor/type";
import type { ComponentType } from "react";

/** The htmlProps_ shape parse products carry (className/style/href/data-*). */
export type InlineRuleProps = RenderData["htmlProps_"];

/**
 * inlineRules v2 — declarative inline syntax engine (compile side).
 *
 * The kernel hardcodes only standard-markdown inline syntax; every extension
 * (including the kernel's own `==highlight==`) is a rule. Hosts inject
 * `InlineRule[]` via DOMDProvider; this module validates and compiles them
 * once into the lookup structures `parseInline` consumes per character.
 *
 * v2 (breaking, no v1 compat): string open/close pairs (asymmetric allowed),
 * Pandoc/Djot-style `{…}` params with `.variant` dispatch, tiered reserved-
 * char opening with capture/longest-prefix disambiguation, and a component
 * render channel. Design doc: project-nexus reference/inline-rules-v2-design.md.
 */

/** Tier 0 — chars that may NEVER appear in a delimiter:
 *  - `` ` `` : code-span sovereignty (everything inside backticks is inert)
 *  - `\`     : the escape system itself
 *  - `{` `}` : the capture microsyntax's own chars */
const NEVER_RULE_CHARS = new Set(["`", "\\", "{", "}"]);

/** Chars that also open a builtin greedy RUN syntax: a delimiter run reaching
 *  the builtin's length belongs to the builtin unless a longer rule claims it.
 *  Only `~` (Del `~~`) today. Consumed by the matcher (parseInline). */
export const BUILTIN_RUN_LEN: Record<string, number> = { "~": 2 };

/** Chars whose builtin construct is opened by a specific FOLLOWING char: rule
 *  matching yields when the char right after the delimiter run matches, so
 *  `![alt](url)` stays an image while `!!x!!` is free for rules. */
export const BUILTIN_NEXT_CHAR: Record<string, string> = { "!": "[" };

/** Tags an InlineRuleSpan may render as. The render layer enforces this too
 *  (defense against tagName_ arriving over sync from a peer with other rules);
 *  anything else falls back to span. */
export const INLINE_RULE_TAG_WHITELIST = new Set([
    "sup",
    "sub",
    "mark",
    "span",
    "u",
    "kbd",
    "ins",
    "small",
    "b",
    "i",
    "s",
    "em",
    "strong",
    "del",
    "abbr",
    "cite",
    "q",
    "var",
]);

/** Base escapable set (CommonMark + do-md extensions). Active rule delimiter
 *  chars are unioned in at compile time so `\^x^` neutralizes a registered
 *  `^` rule. */
const BASE_ESCAPABLE_INLINE = [
    "\\",
    "`",
    "*",
    "_",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "#",
    "+",
    "-",
    ".",
    "!",
    "|",
    "=",
    "~",
    "<",
    ">",
];

/**
 * The kernel's own highlight, expressed as the first shipped rule. Reproduces
 * the legacy hardcoded `==` semantics (non-exact run, spaces allowed, nested
 * inline parsing).
 *
 * Exported publicly so hosts can compose: `[...defaultInlineRules, supRule]`.
 */
export const defaultInlineRules: InlineRule[] = [
    {
        open: "==",
        close: "==",
        tagName: "mark",
        parseInner: true,
    },
];

/** Attribute names an attrs template may target. `data-*` / `aria-*` prefixes
 *  are allowed additionally. Event handlers (`on*`) are unreachable by design. */
const ATTR_TARGET_WHITELIST = new Set(["class", "style", "href", "title", "id"]);

const isValidAttrTarget = (name: string): boolean =>
    ATTR_TARGET_WHITELIST.has(name.toLowerCase()) ||
    /^data-[a-z0-9-]+$/i.test(name) ||
    /^aria-[a-z0-9-]+$/i.test(name);

/** Resolved render config for one dispatch target (rule default or a
 *  variant). Internal (`_`-suffixed, mangled). */
export interface CompiledRuleRender {
    tagName_: string;
    className_?: string;
    attrs_?: Record<string, string>;
    component_?: ComponentType<InlineRuleComponentProps>;
    parseInner_: boolean;
}

/** Normalized rule, defaults filled. Internal (`_`-suffixed, mangled). */
export interface CompiledInlineRule {
    open_: string;
    close_: string;
    /** open is a single char repeated → legacy run-matching semantics apply. */
    openIsRun_: boolean;
    /** close is a single char repeated (used by exactLen close scanning). */
    closeIsRun_: boolean;
    exactLen_: boolean;
    allowSpace_: boolean;
    /** Reserved-delimiter rule: only fires when a valid `{…}` capture follows
     *  the open delimiter (capture presence disambiguates vs the builtin). */
    requiresCapture_: boolean;
    /** Rule-level (default-variant) render config. */
    render_: CompiledRuleRender;
    variants_?: Map<string, CompiledRuleRender>;
}

export interface CompiledInlineRules {
    /** Rules grouped by open[0], longest open first. */
    byChar_: Map<string, CompiledInlineRule[]>;
    /** Render-time dispatch: full open string → rule (component lookup). */
    byOpen_: Map<string, CompiledInlineRule>;
    /** BASE_ESCAPABLE_INLINE ∪ active rule delimiter first-chars. */
    escapable_: Set<string>;
    /** A `==`/`==` rule is active → format('highlight') is meaningful. */
    hasHighlight_: boolean;
    /**
     * Render-trigger regex for EditorController.checkRender_: a rough "this block may
     * contain a rule construct" test that decides immediate reparse vs the
     * debounced pending path. Loose on purpose — a false positive just costs
     * one reparse (the parser itself is the source of truth).
     */
    triggerReg_: RegExp | null;
}

const warnRule = (rule: InlineRule, reason: string) => {
    console.warn(
        `[do-md] inlineRules: dropped rule ${JSON.stringify({
            open: rule?.open,
            close: rule?.close,
        })} — ${reason}`,
    );
};

const isRunString = (s: string): boolean => {
    for (let i = 1; i < s.length; i += 1) {
        if (s[i] !== s[0]) return false;
    }
    return true;
};

/** A delimiter string is structurally valid when every char is punctuation-
 *  like: not alphanumeric, not whitespace, not a Tier-0 char. */
const invalidDelimReason = (s: unknown): string | null => {
    if (typeof s !== "string" || s.length === 0) {
        return "open/close must be non-empty strings";
    }
    for (const ch of s) {
        if (NEVER_RULE_CHARS.has(ch)) {
            return `char "${ch}" can never be part of a delimiter (code-span/escape/capture sovereignty)`;
        }
        if (/[A-Za-z0-9\s]/.test(ch)) {
            return "delimiters must not contain alphanumeric or whitespace chars";
        }
    }
    return null;
};

/**
 * Builtin-collision policy for an open delimiter (design doc §4). Returns:
 *  - "none"     — no conflict, or the conflict is resolved at runtime
 *                 (shorter-than-builtin runs yield via BUILTIN_RUN_LEN /
 *                 BUILTIN_NEXT_CHAR) or by longest-prefix precedence.
 *  - "capture"  — the open exactly shadows a builtin trigger; the rule is
 *                 kept but only fires with a valid `{…}` capture.
 */
const openCollision = (open: string): "none" | "capture" => {
    // `*` — builtin em/bold/embold match greedy runs of 1..3+; no run length
    // escapes, so capture is the only signal.
    if (open[0] === "*") return "capture";
    // `![` — exactly the image prefix.
    if (open.startsWith("![")) return "capture";
    // `[` — builtin link/badge trigger; `[[…` is a strictly longer prefix and
    // wins by precedence (wikilink unlock).
    if (open[0] === "[") return open.length === 1 ? "capture" : "none";
    // `<` — builtin inline HTML + autolink; `<{` is unclaimed by both, and
    // multi-char opens (`<<`) win by precedence.
    if (open[0] === "<") return open.length === 1 ? "capture" : "none";
    // `~` — builtin `~~` Del. A single `~` yields at runtime via
    // BUILTIN_RUN_LEN; `~~` exactly shadows Del → capture; `~~~`+ wins by
    // longest-prefix precedence.
    if (open === "~~") return "capture";
    return "none";
};

const compileRender = (
    source: {
        tagName?: string;
        className?: string;
        attrs?: Record<string, string>;
        component?: ComponentType<InlineRuleComponentProps>;
        parseInner?: boolean;
    },
    fallback: CompiledRuleRender,
): CompiledRuleRender => {
    let tagName = source.tagName ?? fallback.tagName_;
    if (!INLINE_RULE_TAG_WHITELIST.has(tagName.toLowerCase())) {
        console.warn(
            `[do-md] inlineRules: tagName "${tagName}" is not whitelisted — rendering as span`,
        );
        tagName = "span";
    } else {
        tagName = tagName.toLowerCase();
    }

    let attrs: Record<string, string> | undefined;
    const sourceAttrs = source.attrs ?? fallback.attrs_;
    if (sourceAttrs) {
        for (const [name, template] of Object.entries(sourceAttrs)) {
            if (!isValidAttrTarget(name) || typeof template !== "string") {
                console.warn(
                    `[do-md] inlineRules: attrs["${name}"] is not an allowed attribute target — dropped`,
                );
                continue;
            }
            (attrs ??= {})[name.toLowerCase()] = template;
        }
    }

    return {
        tagName_: tagName,
        className_: source.className ?? fallback.className_,
        attrs_: attrs,
        component_:
            typeof source.component === "function"
                ? source.component
                : fallback.component_,
        parseInner_: source.parseInner ?? fallback.parseInner_,
    };
};

/**
 * Validate + compile host rules. Invalid rules are dropped with a warn (never
 * throw — the editor must stay usable). `undefined` compiles the default set.
 */
export const compileInlineRules = (
    rules: InlineRule[] | undefined,
): CompiledInlineRules => {
    const source = rules ?? defaultInlineRules;
    const byChar = new Map<string, CompiledInlineRule[]>();
    const byOpen = new Map<string, CompiledInlineRule>();
    const escapable = new Set(BASE_ESCAPABLE_INLINE);

    for (const rule of source) {
        const openReason = invalidDelimReason(rule?.open);
        if (openReason) {
            warnRule(rule, openReason);
            continue;
        }
        const closeReason = invalidDelimReason(rule?.close);
        if (closeReason) {
            warnRule(rule, closeReason);
            continue;
        }
        const open = rule.open;
        const close = rule.close;

        const requiresCapture = openCollision(open) === "capture";

        const baseRender: CompiledRuleRender = compileRender(rule, {
            tagName_: "span",
            parseInner_: true,
        });

        let variants: Map<string, CompiledRuleRender> | undefined;
        if (rule.variants) {
            for (const [word, variant] of Object.entries(rule.variants)) {
                if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(word)) {
                    console.warn(
                        `[do-md] inlineRules: variant name "${word}" is not a valid word — dropped`,
                    );
                    continue;
                }
                (variants ??= new Map()).set(
                    word,
                    compileRender(variant ?? {}, baseRender),
                );
            }
        }

        const compiled: CompiledInlineRule = {
            open_: open,
            close_: close,
            openIsRun_: isRunString(open),
            closeIsRun_: isRunString(close),
            // Mixed-char delimiters are literal strings — always exact.
            exactLen_: isRunString(open) ? (rule.exactLen ?? false) : true,
            allowSpace_: rule.allowSpace ?? true,
            requiresCapture_: requiresCapture,
            render_: baseRender,
            variants_: variants,
        };

        if (byOpen.has(open)) {
            console.warn(
                `[do-md] inlineRules: duplicate rule for open "${open}" — the later one wins`,
            );
            const bucket = byChar.get(open[0]);
            const dupIndex = bucket?.findIndex((r) => r.open_ === open) ?? -1;
            if (bucket && dupIndex !== -1) bucket.splice(dupIndex, 1);
        }
        byOpen.set(open, compiled);
        const bucket = byChar.get(open[0]) ?? [];
        bucket.push(compiled);
        byChar.set(open[0], bucket);
        escapable.add(open[0]);
        escapable.add(close[0]);
    }

    // Longest opens first: `[[` must be probed before a hypothetical `[`
    // rule, and `!!!` before `!!`, deterministically regardless of host
    // array order (longest-prefix precedence, design doc §4).
    for (const bucket of byChar.values()) {
        bucket.sort((a, b) => b.open_.length - a.open_.length);
    }

    const highlightRule = byOpen.get("==");
    const hasHighlight = highlightRule?.close_ === "==";

    // Build the render-trigger regex: one alternation per rule,
    // `open ({…})? content close`. requiresCapture rules make the capture
    // part mandatory (narrower false positives — without a `{` the rule can
    // never fire anyway). Content is non-greedy; `\S` for no-space rules.
    const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alternations: string[] = [];
    for (const bucket of byChar.values()) {
        for (const rule of bucket) {
            const capturePart = rule.requiresCapture_
                ? "\\{[^\\n]*?\\}"
                : "(?:\\{[^\\n]*?\\})?";
            const content = rule.allowSpace_ ? ".+?" : "\\S+?";
            alternations.push(
                `${escapeReg(rule.open_)}${capturePart}${content}${escapeReg(rule.close_)}`,
            );
        }
    }
    const triggerReg = alternations.length
        ? new RegExp(`(?:${alternations.join("|")})`)
        : null;

    return {
        byChar_: byChar,
        byOpen_: byOpen,
        escapable_: escapable,
        hasHighlight_: hasHighlight ?? false,
        triggerReg_: triggerReg,
    };
};

/** Compiled default set — the fallback wherever no ParseConfig is threaded,
 *  so a missed call site degrades to default behavior, never to broken `==`. */
export const COMPILED_DEFAULT_INLINE_RULES = compileInlineRules(undefined);

/** Public htmlProps_ keys carrying rule metadata on the content node. They
 *  flow to the DOM as data attributes (CSS-targetable) and through the sync
 *  layer verbatim (peers re-dispatch components against their own rule set). */
export const DATA_INLINE_RULE = "data-inline-rule";
export const DATA_INLINE_VARIANT = "data-inline-variant";
export const DATA_INLINE_CAPTURE = "data-inline-capture";

/** kebab-case CSS property → React camelCase (`background-color` →
 *  `backgroundColor`). Custom properties (`--x`) pass through untouched. */
const cssPropToReact = (prop: string): string =>
    prop.startsWith("--")
        ? prop
        : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Parse a CSS declaration list (`a: b; c: d`) into a React style object.
 *  Purely structural — no url()/expression execution surface via React's
 *  style prop. Malformed declarations are skipped. */
const parseStyleText = (text: string): Record<string, string> | undefined => {
    const style: Record<string, string> = {};
    let any = false;
    for (const decl of text.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        const prop = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        if (!prop || !value) continue;
        style[cssPropToReact(prop)] = value;
        any = true;
    }
    return any ? style : undefined;
};

const PLACEHOLDER_REG = /\{([A-Za-z_][A-Za-z0-9_-]*)?\}/g;

/**
 * Substitute `{key}` / `{}` placeholders from params. Returns null when any
 * referenced value is missing/empty — the attr is then voided entirely
 * (never render a half-substituted value). A template with no placeholders
 * passes through as-is.
 */
const applyAttrTemplate = (
    template: string,
    params: InlineRuleParams | null,
): string | null => {
    let missing = false;
    const result = template.replace(PLACEHOLDER_REG, (_, key?: string) => {
        const value = key ? params?.named[key] : params?.positional[0];
        if (value === undefined || value === "") {
            missing = true;
            return "";
        }
        return value;
    });
    return missing ? null : result;
};

/**
 * React props for a matched rule occurrence: rule/variant className + param
 * classes + attrs templates + rule metadata data-attrs.
 * Always returns a FRESH object (parse products must not share references).
 *
 * The raw capture text stays verbatim in the opening MdSymbol regardless of
 * what happens here — a voided attr only cancels the visual effect, never
 * the document text.
 */
export const resolveInlineRuleProps = (
    rule: CompiledInlineRule,
    render: CompiledRuleRender,
    params: InlineRuleParams | null,
    rawCapture: string | null,
): InlineRuleProps => {
    const props: InlineRuleProps = {};

    const classes = [
        render.className_,
        ...(params?.classes ?? []),
    ].filter(Boolean) as string[];

    if (params?.id) props.id = params.id;

    if (render.attrs_) {
        for (const [name, template] of Object.entries(render.attrs_)) {
            const value = applyAttrTemplate(template, params);
            if (value === null || !value) continue;

            if (name === "class") {
                classes.push(...value.split(/\s+/).filter(Boolean));
                continue;
            }
            if (name === "style") {
                const style = parseStyleText(value);
                if (style) props.style = style;
                continue;
            }
            if (name === "href") {
                // Block script-scheme URLs; everything else (http/https/
                // mailto/relative/#anchor) passes through.
                if (/^\s*javascript:/i.test(value)) continue;
                props.href = value;
                continue;
            }
            // title / id / data-* / aria-* — validated at compile time.
            props[name] = value;
        }
    }

    if (classes.length) props.className = classes.join(" ");

    // Rule metadata for CSS targeting + render-time component dispatch.
    props[DATA_INLINE_RULE] = rule.open_;
    if (params?.variant) props[DATA_INLINE_VARIANT] = params.variant;
    if (render.component_ && rawCapture !== null) {
        props[DATA_INLINE_CAPTURE] = rawCapture;
    }

    return props;
};
