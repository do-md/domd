import { MarkdownType } from "../../editor/type/enum";
import { ParentRenderData, RenderData } from "../../editor/type";
import { nanoid8 } from "@do-md/utils";
import { CursorMarker } from "../../editor/constant";
import { createTextRenderData } from "../create-render-data/createTextRenderData";
import { createParentRenderData } from "../create-render-data/createParentRenderData";
import { getParseContext } from "../parseMarkdown";
import {
    BUILTIN_NEXT_CHAR,
    BUILTIN_RUN_LEN,
    COMPILED_DEFAULT_INLINE_RULES,
    CompiledInlineRule,
    CompiledRuleRender,
    InlineRuleProps,
    resolveInlineRuleProps,
} from "../inline-rules";
import {
    parseInlineRuleParams,
    scanInlineCapture,
} from "../inline-rule-params";
import { InlineRuleParams } from "../../editor/type";

const imgReg = /^!\[[^\]]*\]\((.*?)\s*("(?:.*[^"])")?\s*\)/;
const imgUrlReg = /\(([^)]+)\)/;
const badgeReg = /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/;
const linkReg = /^\[([^\]]+)\]\(([^)]+)\)/;

// GFM-style bare URL autolink. A URL written in plain text (no `[]()` or `<>`
// syntax) becomes a clickable Link. The grammar grabs everything up to the
// next space or `<`, then trailing punctuation is trimmed (see
// trimTrailingUrlPunctuation) so `(see https://x.com).` keeps the `.` and `)`
// as literal text. Kept library-free on purpose.
const URL_SCHEME_REG = /^(?:https?:\/\/|ftp:\/\/|www\.)/i;
const bareUrlReg = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+/i;

// First chars that can begin a bare URL — cheap gate so we only run the regex
// on candidates rather than every character.
const URL_START_CHARS = new Set(["h", "H", "w", "W", "f", "F"]);

// Trailing punctuation that is almost never part of the URL itself, so it is
// peeled off and rendered as literal text. Mirrors common autolinkers and
// includes CJK punctuation.
const TRAILING_URL_PUNCTUATION = new Set<string>([
    ".",
    ",",
    "!",
    "?",
    ":",
    ";",
    "'",
    '"',
    ")",
    "]",
    "}",
    ">",
    "`",
    "，",
    "。",
    "！",
    "？",
    "：",
    "；",
    "、",
    "）",
    "】",
    "》",
    "』",
    "」",
    "〕",
    "〉",
    "›",
]);

// Closing -> opening map: a closing bracket is only trimmed when it is
// unbalanced (e.g. the `)` in `(https://x.com/a)`), so paths that legitimately
// contain balanced brackets like `https://x.com/a_(b)` stay intact.
const PAIRED_URL_PUNCTUATION: Record<string, string> = {
    ")": "(",
    "]": "[",
    "}": "{",
    ">": "<",
    "）": "（",
    "】": "【",
    "》": "《",
    "」": "「",
    "』": "『",
    "〕": "〖",
    "〉": "〈",
    "›": "‹",
};

// Inline HTML tags handled with hidden open/close MdSymbols.
// Keep in sync with INLINE_HTML_TAGS in gettext/getHTMLText.ts so block
// parsing doesn't swallow them first.
const INLINE_TAG_TO_TYPE: Record<string, MarkdownType> = {
    ins: MarkdownType.Ins,
    sub: MarkdownType.Sub,
    sup: MarkdownType.Sup,
    u: MarkdownType.U,
    kbd: MarkdownType.Kbd,
    mark: MarkdownType.Mark,
};
const inlineTagReg = /^<(ins|sub|sup|u|kbd|mark)>([\s\S]*?)<\/\1>/;

// Escapable chars now come from the compiled inline rules (base CommonMark set
// ∪ active rule chars — see data-parse/inline-rules.ts), so `\^x^` neutralizes
// a host-registered `^` rule exactly like `\==` neutralizes highlight.

/** Match result for a declarative inline rule at a given scan position. */
interface InlineRuleMatch {
    rule_: CompiledInlineRule;
    /** Dispatched render config (matched variant, or the rule default). */
    render_: CompiledRuleRender;
    /** Opening delimiter incl. an optionally captured `{…}` (raw text). */
    openText_: string;
    /** Closing delimiter. */
    closeText_: string;
    /** Index of the closing delimiter's first char. */
    closeIndex_: number;
    params_: InlineRuleParams | null;
    rawCapture_: string | null;
}

// Try every rule registered for the first char at `charIndex`, longest open
// first (longest-prefix precedence: `[[` probes before `[`). Run-shaped opens
// (`==`) keep the legacy semantics — non-exact rules open with exactly
// open.length chars regardless of a longer run, exactLen rules require the
// exact run (`^^x^` stays literal). Mixed-string opens (`[[`, `<`) match
// literally. A valid `{…}` capture right after the open is consumed into the
// opening text; reserved-delimiter rules (requiresCapture_) only fire when it
// parses — otherwise the position falls through to the builtin syntax.
const matchInlineRuleAt = (
    text: string,
    charIndex: number,
    rules: CompiledInlineRule[],
): InlineRuleMatch | null => {
    const ch = text[charIndex];
    let runLen = 1;
    while (text[charIndex + runLen] === ch) runLen += 1;
    const prevIsSameChar = charIndex > 0 && text[charIndex - 1] === ch;

    for (const rule of rules) {
        const openLen = rule.open_.length;

        if (rule.openIsRun_) {
            // A run reaching a builtin greedy syntax's length belongs to the
            // builtin (`~~` → Del) unless this rule's open is at least as
            // long (a registered `~~`-with-capture or `~~~` rule may claim).
            const builtinLen = BUILTIN_RUN_LEN[ch];
            if (
                builtinLen !== undefined &&
                openLen < builtinLen &&
                runLen >= builtinLen
            ) {
                continue;
            }
            // A delimiter run followed by a builtin-opening char belongs to
            // the builtin (`![` → image): `!!x!!` stays claimable while
            // `!![alt](url)` falls through — literal `!`, then the image.
            const yieldNext = BUILTIN_NEXT_CHAR[ch];
            if (
                yieldNext !== undefined &&
                text[charIndex + runLen] === yieldNext
            ) {
                continue;
            }
            // exactLen opening runs must not start mid-run: in `^^x^` the
            // scan reaches the second `^` (forward runLen 1) but it belongs
            // to a run of 2, so the whole thing stays literal.
            if (rule.exactLen_) {
                if (prevIsSameChar || runLen !== openLen) continue;
            } else if (runLen < openLen) {
                continue;
            }
        } else if (!text.startsWith(rule.open_, charIndex)) {
            continue;
        }

        // `{…}` capture scan (quote-aware) + microsyntax parse. A malformed
        // capture counts as absent — all-or-nothing keeps the reserved-char
        // disambiguation deterministic.
        let rawCapture: string | null = null;
        let params: InlineRuleParams | null = null;
        let captureLen = 0;
        if (text[charIndex + openLen] === "{") {
            const scanned = scanInlineCapture(text, charIndex + openLen);
            if (scanned) {
                const parsed = parseInlineRuleParams(scanned.raw_);
                if (parsed) {
                    rawCapture = scanned.raw_;
                    params = parsed;
                    captureLen = scanned.length_;
                }
            }
        }
        if (rule.requiresCapture_ && params === null) continue;

        const openText = text.slice(
            charIndex,
            charIndex + openLen + captureLen,
        );

        // Closing delimiter search (≥1 char of content). exactLen run closes
        // additionally require the closing run to be exactly open-length.
        const cc = rule.close_[0];
        let searchFrom = charIndex + openText.length + 1;
        let closeIndex = -1;
        while (closeIndex === -1) {
            const idx = text.indexOf(rule.close_, searchFrom);
            if (idx === -1) break;
            if (rule.exactLen_ && rule.closeIsRun_) {
                const prevIsRun =
                    idx > charIndex + openText.length && text[idx - 1] === cc;
                const nextIsRun = text[idx + rule.close_.length] === cc;
                if (prevIsRun || nextIsRun) {
                    // Part of a longer run — skip past the whole run.
                    let skip = idx;
                    while (text[skip] === cc) skip += 1;
                    searchFrom = skip;
                    continue;
                }
            }
            closeIndex = idx;
        }
        if (closeIndex === -1) continue;

        const inner = text.slice(charIndex + openText.length, closeIndex);

        // Same-char run rules: content that is only delimiter chars is never
        // intended markup (generalizes the old Setext `=====` guard).
        if (rule.openIsRun_ && cc === ch) {
            let onlyDelims = true;
            for (const c of inner) {
                if (c !== ch) {
                    onlyDelims = false;
                    break;
                }
            }
            if (onlyDelims) continue;
        }
        if (!rule.allowSpace_ && /\s/.test(inner)) continue;

        // Variant dispatch: first `.word` → registered variant, else default.
        const render =
            (params?.variant !== undefined
                ? rule.variants_?.get(params.variant)
                : undefined) ?? rule.render_;

        return {
            rule_: rule,
            render_: render,
            openText_: openText,
            closeText_: rule.close_,
            closeIndex_: closeIndex,
            params_: params,
            rawCapture_: rawCapture,
        };
    }
    return null;
};

export const parseInline = ({
    parseText_,
    renderData_,
}: {
    parseText_: string;
    renderData_: ParentRenderData;
}): string => {
    // Block parsers strip CursorMarkers (and report their positions) before
    // delegating here, so inline text is normally marker-free. A defensive
    // strip guards block types that only handle the first marker: an inline
    // format op can leave a second (selection-end) marker behind, which would
    // otherwise render as a stray invisible char.
    if (parseText_.includes(CursorMarker)) {
        parseText_ = parseText_.split(CursorMarker).join("");
    }

    // Declarative inline rules (host-injected via DOMDProvider, compiled in
    // the store). Fallback to the compiled defaults keeps `==` working for
    // any entry path that doesn't thread a ParseConfig.
    const inlineRules =
        getParseContext().inlineRules_ ?? COMPILED_DEFAULT_INLINE_RULES;

    for (
        let charIndex = 0, len = parseText_.length;
        charIndex < len;
        charIndex += 1
    ) {
        // Bare URL autolink. Runs before the switch so a plain-text URL is
        // caught wherever it sits between other inline markup. Markdown link
        // forms (`[](url)`, `<url>`, `![](url)`) are consumed by their own
        // branches at the `[`/`<`/`!` position, so their inner URLs never reach
        // this scan — no double-linkification.
        if (URL_START_CHARS.has(parseText_[charIndex])) {
            // Require a boundary before the scheme so `shttp://x` (URL glued to
            // a word) is not linkified.
            const prevChar =
                charIndex > 0 ? parseText_[charIndex - 1] : "";
            const atBoundary = !prevChar || !/[a-z0-9@]/i.test(prevChar);

            const url = atBoundary
                ? matchBareUrl(parseText_, charIndex)
                : null;
            if (url) {
                const preText = parseText_.slice(0, charIndex);
                if (preText) {
                    renderData_.children_.push(
                        createTextRenderData({ text_: preText }),
                    );
                }

                // No MdSymbols: the visible text *is* the URL, so toMarkdown
                // emits the child text verbatim and the round-trip holds.
                renderData_.children_.push({
                    htmlType_: MarkdownType.Link,
                    children_: [createTextRenderData({ text_: url })],
                    uuid_: nanoid8(),
                    mdSymbols_: [],
                    htmlProps_: {
                        href: /^www\./i.test(url) ? `http://${url}` : url,
                    },
                });

                parseText_ = parseText_.slice(charIndex + url.length);
                if (parseText_.length) {
                    return parseInline({
                        parseText_: parseText_,
                        renderData_: renderData_,
                    });
                }
                return "";
            }
        }

        // Declarative inline rules — probed BEFORE the builtin switch: the
        // precedence chain is user rule → builtin → literal (design doc §4).
        // Reserved-delimiter rules only fire on shapes builtins never produce
        // (a valid `{…}` capture after the open, or a strictly longer open
        // like `[[`), so plain builtin syntax always falls through to the
        // switch below. matchInlineRuleAt additionally yields runs to greedy
        // builtins (`~~` → Del) and `![` to images.
        const ruleBucket = inlineRules.byChar_.get(parseText_[charIndex]);
        if (ruleBucket) {
            const ruleMatch = matchInlineRuleAt(
                parseText_,
                charIndex,
                ruleBucket,
            );
            if (ruleMatch) {
                createMarkdownData({
                    parseText_: parseText_,
                    renderData_: renderData_,
                    symbol_: ruleMatch.closeText_,
                    openText_: ruleMatch.openText_,
                    charIndex_: charIndex,
                    nextSymbolIndex_: ruleMatch.closeIndex_,
                    markdownType_: MarkdownType.InlineRuleSpan,
                    checkDeep_: ruleMatch.render_.parseInner_,
                    contentTagName_: ruleMatch.render_.tagName_,
                    contentProps_: resolveInlineRuleProps(
                        ruleMatch.rule_,
                        ruleMatch.render_,
                        ruleMatch.params_,
                        ruleMatch.rawCapture_,
                    ),
                });

                // Extract remaining characters and continue processing
                parseText_ = parseText_.slice(
                    ruleMatch.closeIndex_ + ruleMatch.closeText_.length,
                );
                if (parseText_.length) {
                    return parseInline({
                        parseText_: parseText_,
                        renderData_: renderData_,
                    });
                }
                return "";
            }
        }

        switch (parseText_[charIndex]) {
            case "\\": {
                // `\<escapable>` renders the escapable char as a literal.
                // Structure: Plain wrapper with [MdSymbol("\\"), Plain(next)].
                // The `\` itself is hidden unless the cursor enters the group.
                // toMarkdown concats children text verbatim → round-trip holds.
                const next = parseText_[charIndex + 1];
                if (!next || !inlineRules.escapable_.has(next)) break;

                const preText = parseText_.slice(0, charIndex);
                if (preText) {
                    renderData_.children_.push(
                        createTextRenderData({ text_: preText }),
                    );
                }

                const escId = nanoid8();
                const group: ParentRenderData = {
                    htmlType_: MarkdownType.Plain,
                    children_: [
                        createTextRenderData({
                            htmlType_: MarkdownType.MdSymbol,
                            text_: "\\",
                            uuid_: escId,
                            mdSymbols_: [escId],
                        }),
                        // The escaped char itself: a visible Plain leaf (NOT a
                        // second `\` — that was a copy-paste bug that doubled
                        // the backslash and dropped the char on round-trip).
                        createTextRenderData({
                            text_: next,
                            mdSymbols_: [escId],
                        }),
                    ],
                    uuid_: nanoid8(),
                    mdSymbols_: [],
                    htmlProps_: {},
                };
                renderData_.children_.push(group);

                parseText_ = parseText_.slice(charIndex + 2);
                if (parseText_.length) {
                    return parseInline({
                        parseText_: parseText_,
                        renderData_: renderData_,
                    });
                }
                return "";
            }
            case "`": {
                let symbol = "";
                let nextSymbolIndex = -1;

                // Match the actual symbol
                for (
                    let symbolIndex = charIndex;
                    symbolIndex < len;
                    symbolIndex += 1
                ) {
                    if (parseText_[symbolIndex] === "`") {
                        const newSymbol = `${symbol}\``;
                        const newNextSymbolIndex = parseText_.indexOf(
                            newSymbol,
                            charIndex + newSymbol.length + 1,
                        );
                        if (newNextSymbolIndex === -1) break;
                        symbol = newSymbol;
                        nextSymbolIndex = newNextSymbolIndex;
                    } else {
                        break;
                    }
                }

                if (nextSymbolIndex === -1) break;

                createMarkdownData({
                    parseText_: parseText_,
                    renderData_: renderData_,
                    symbol_: symbol,
                    charIndex_: charIndex,
                    nextSymbolIndex_: nextSymbolIndex,
                    markdownType_: MarkdownType.Code,
                });

                // Extract remaining characters and continue processing
                parseText_ = parseText_.slice(nextSymbolIndex + symbol.length);
                if (parseText_.length) {
                    return parseInline({
                        parseText_: parseText_,
                        renderData_: renderData_,
                    });
                }
                return "";
            }
            // NOTE: `==` highlight is no longer hardcoded here — it lives in
            // defaultInlineRules (data-parse/inline-rules.ts) and goes through
            // the rule branch above, same as any host-registered syntax.
            case "~": {
                if (parseText_[charIndex + 1] !== "~") break;
                const symbol = "~~";
                const nextSymbolIndex = parseText_.indexOf(
                    symbol,
                    charIndex + symbol.length + 1,
                );
                if (nextSymbolIndex === -1) break;

                createMarkdownData({
                    parseText_: parseText_,
                    renderData_: renderData_,
                    symbol_: symbol,
                    charIndex_: charIndex,
                    nextSymbolIndex_: nextSymbolIndex,
                    markdownType_: MarkdownType.Del,
                    checkDeep_: true,
                });
                // Extract remaining characters and continue processing
                parseText_ = parseText_.slice(nextSymbolIndex + 2);
                if (parseText_.length) {
                    return parseInline({
                        parseText_: parseText_,
                        renderData_: renderData_,
                    });
                }
                return "";
            }
            case "*": {
                let symbol = "";
                let nextSymbolIndex = -1;

                // Match the actual symbol
                for (
                    let symbolIndex = charIndex;
                    symbolIndex < parseText_.length;
                    symbolIndex += 1
                ) {
                    if (parseText_[symbolIndex] === "*") {
                        const newSymbol = `${symbol}*`;
                        const newNextSymbolIndex = parseText_.indexOf(
                            newSymbol,
                            charIndex + newSymbol.length + 1,
                        );
                        if (newNextSymbolIndex === -1) break;
                        symbol = newSymbol;
                        nextSymbolIndex = newNextSymbolIndex;
                        if (newSymbol.length >= 3) break;
                    } else {
                        break;
                    }
                }

                if (nextSymbolIndex === -1) break;

                createMarkdownData({
                    parseText_: parseText_,
                    renderData_: renderData_,
                    symbol_: symbol,
                    charIndex_: charIndex,
                    nextSymbolIndex_: nextSymbolIndex,

                    markdownType_:
                        symbol.length === 1
                            ? MarkdownType.Em
                            : symbol.length === 2
                              ? MarkdownType.Bold
                              : symbol.length === 3
                                ? MarkdownType.EmBold
                                : MarkdownType.EmBold,
                    checkDeep_: true,
                });

                // Extract remaining characters and continue processing
                parseText_ = parseText_.slice(nextSymbolIndex + symbol.length);
                if (parseText_.length) {
                    return parseInline({
                        parseText_: parseText_,
                        renderData_: renderData_,
                    });
                }
                return "";
            }
            case "!": {
                if (imgReg.test(parseText_.slice(charIndex))) {
                    const imgMarkdown = parseText_
                        .slice(charIndex)
                        ?.match(imgReg)?.[0];
                    const src = imgMarkdown?.match(imgUrlReg)?.[1];

                    const preText = parseText_.slice(0, charIndex);
                    if (preText) {
                        renderData_.children_.push(
                            createTextRenderData({ text_: preText }),
                        );
                    }

                    const symbolId = nanoid8();
                    const parent: ParentRenderData = {
                        htmlType_: MarkdownType.Plain,
                        children_: [
                            {
                                htmlType_: MarkdownType.MdSymbol,
                                text_: imgMarkdown || "",
                                uuid_: symbolId,
                                mdSymbols_: [symbolId],
                                htmlProps_: {},
                            },
                            {
                                htmlType_: MarkdownType.Img,
                                text_: "",
                                uuid_: nanoid8(),
                                mdSymbols_: [symbolId],
                                htmlProps_: {
                                    src,
                                },
                            },
                        ],
                        uuid_: nanoid8(),
                        mdSymbols_: [symbolId],
                        htmlProps_: {},
                    };
                    renderData_.children_.push(parent);

                    // Extract remaining characters and continue processing
                    parseText_ = parseText_.slice(
                        charIndex + (imgMarkdown?.length || 0),
                    );
                    if (parseText_.length) {
                        return parseInline({
                            parseText_: parseText_,
                            renderData_: renderData_,
                        });
                    }
                    return "";
                }
                break;
            }

            case "[": {
                const badgeMatch = parseText_.slice(charIndex).match(badgeReg);
                if (badgeMatch) {
                    const fullBadgeText = badgeMatch[0]; // Full badge text, i.e., [![Text](URL)](URL)
                    const badgeAlt = badgeMatch[1]; // Badge alt text part
                    const badgeImgUrl = badgeMatch[2]; // Badge image URL part
                    const badgeLinkUrl = badgeMatch[3]; // Badge link URL part

                    // Symbol IDs
                    const symbol1Id = nanoid8(); // [
                    const symbol2Id = nanoid8(); // ![alt](imgUrl)
                    const symbol3Id = nanoid8(); // ](
                    const symbol4Id = nanoid8(); // linkUrl
                    const symbol5Id = nanoid8(); // )

                    const allSymbolIds = [
                        symbol1Id,
                        symbol2Id,
                        symbol3Id,
                        symbol4Id,
                        symbol5Id,
                    ];

                    // Add preceding text
                    const preText = parseText_.slice(0, charIndex);
                    if (preText) {
                        renderData_.children_.push(
                            createTextRenderData({ text_: preText }),
                        );
                    }

                    // Create the badge link parent node
                    const badgeNodeData: ParentRenderData = {
                        htmlType_: MarkdownType.Link,
                        children_: [],
                        uuid_: nanoid8(),
                        mdSymbols_: allSymbolIds,
                        htmlProps_: {
                            href: badgeLinkUrl,
                        },
                    };

                    // Symbol: [
                    badgeNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: "[",
                        uuid_: symbol1Id,
                        mdSymbols_: allSymbolIds,
                        htmlProps_: {},
                    });

                    // Image container (Plain wrapper with image inside)
                    const imgContainer: ParentRenderData = {
                        htmlType_: MarkdownType.Plain,
                        children_: [
                            {
                                htmlType_: MarkdownType.MdSymbol,
                                text_: `![${badgeAlt}](${badgeImgUrl})`,
                                uuid_: symbol2Id,
                                mdSymbols_: allSymbolIds,
                                htmlProps_: {},
                            },
                            {
                                htmlType_: MarkdownType.Img,
                                text_: "",
                                uuid_: nanoid8(),
                                mdSymbols_: allSymbolIds,
                                htmlProps_: {
                                    src: badgeImgUrl,
                                    alt: badgeAlt,
                                    style: {
                                        display: "inline",
                                    },
                                },
                            },
                        ],
                        uuid_: nanoid8(),
                        mdSymbols_: allSymbolIds,
                        htmlProps_: {},
                    };
                    badgeNodeData.children_.push(imgContainer);

                    // Symbol: ](
                    badgeNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: "](",
                        uuid_: symbol3Id,
                        mdSymbols_: allSymbolIds,
                        htmlProps_: {},
                    });

                    // Symbol: linkUrl
                    badgeNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: badgeLinkUrl,
                        uuid_: symbol4Id,
                        mdSymbols_: allSymbolIds,
                        htmlProps_: {},
                    });

                    // Symbol: )
                    badgeNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: ")",
                        uuid_: symbol5Id,
                        mdSymbols_: allSymbolIds,
                        htmlProps_: {},
                    });

                    renderData_.children_.push(badgeNodeData);

                    // Extract remaining characters and continue processing
                    parseText_ = parseText_.slice(
                        charIndex + fullBadgeText.length,
                    );
                    if (parseText_.length) {
                        return parseInline({
                            parseText_: parseText_,
                            renderData_: renderData_,
                        });
                    }
                    return "";
                }

                // Get the first matching link
                const match = parseText_.slice(charIndex).match(linkReg);

                if (match) {
                    const fullLinkText = match[0]; // Full link text, i.e., [Text](URL)
                    const linkText = match[1]; // Link text part
                    const linkUrl = match[2]; // Link URL part
                    const linkUrlId = nanoid8();

                    const symbol1Id = nanoid8();
                    const symbol1Text = "[";
                    const symbol2Id = nanoid8();
                    const symbol2Text = "]";
                    const symbol3Id = nanoid8();
                    const symbol3Text = "(";
                    const symbol4Id = nanoid8();
                    const symbol4Text = ")";

                    const preText = parseText_.slice(0, charIndex);
                    if (preText) {
                        renderData_.children_.push(
                            createTextRenderData({ text_: preText }),
                        );
                    }

                    const parentNodeData: ParentRenderData = {
                        htmlType_: MarkdownType.Link,
                        children_: [],
                        uuid_: nanoid8(),
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {
                            href: linkUrl,
                        },
                    };

                    parentNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: symbol1Text,
                        uuid_: symbol1Id,
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {},
                    });

                    const spanParent: ParentRenderData = {
                        htmlType_: MarkdownType.Plain,
                        children_: [],
                        uuid_: nanoid8(),
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {},
                    };
                    parentNodeData.children_.push(spanParent);

                    const remainText = parseInline({
                        parseText_: linkText,
                        renderData_: spanParent,
                    });

                    const queue = [...spanParent.children_];
                    while (queue.length) {
                        const cur = queue.shift();
                        cur?.mdSymbols_.push(
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        );
                        if (cur?.children_) {
                            queue.push(...cur.children_);
                        }
                    }

                    if (remainText) {
                        spanParent.children_.push({
                            htmlType_: MarkdownType.Plain,
                            text_: remainText,
                            uuid_: nanoid8(),
                            mdSymbols_: [
                                symbol1Id,
                                symbol2Id,
                                symbol3Id,
                                symbol4Id,
                                linkUrlId,
                            ],
                            htmlProps_: {},
                        });
                    }

                    parentNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: symbol2Text,
                        uuid_: symbol2Id,
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {},
                    });

                    parentNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: symbol3Text,
                        uuid_: symbol3Id,
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {},
                    });

                    parentNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: linkUrl,
                        uuid_: linkUrlId,
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {},
                    });

                    parentNodeData.children_.push({
                        htmlType_: MarkdownType.MdSymbol,
                        text_: symbol4Text,
                        uuid_: symbol4Id,
                        mdSymbols_: [
                            symbol1Id,
                            symbol2Id,
                            symbol3Id,
                            symbol4Id,
                            linkUrlId,
                        ],
                        htmlProps_: {},
                    });

                    renderData_.children_.push(parentNodeData);

                    // Extract remaining characters and continue processing
                    parseText_ = parseText_.slice(
                        charIndex + fullLinkText.length,
                    );
                    if (parseText_.length) {
                        return parseInline({
                            parseText_: parseText_,
                            renderData_: renderData_,
                        });
                    }
                    return "";
                }
                break;
            }
            case "<": {
                // Inline HTML tags with matching open/close (see
                // INLINE_TAG_TO_TYPE). Content recurses so nested inline markup
                // (e.g. `<u>**bold**</u>`) parses instead of staying literal —
                // same promote-only-if-nested rule as createMarkdownData.
                const inlineTagMatch = parseText_
                    .slice(charIndex)
                    .match(inlineTagReg);
                if (inlineTagMatch) {
                    const fullMatch = inlineTagMatch[0];
                    const tagName = inlineTagMatch[1];
                    const innerText = inlineTagMatch[2];
                    const openText = `<${tagName}>`;
                    const closeText = `</${tagName}>`;

                    const openId = nanoid8();
                    const closeId = nanoid8();
                    const symbolIds = [openId, closeId];
                    const contentType = INLINE_TAG_TO_TYPE[tagName];

                    const preText = parseText_.slice(0, charIndex);
                    if (preText) {
                        renderData_.children_.push(
                            createTextRenderData({ text_: preText }),
                        );
                    }

                    let contentNode: RenderData | ParentRenderData = {
                        htmlType_: contentType,
                        text_: innerText,
                        uuid_: nanoid8(),
                        mdSymbols_: symbolIds,
                        htmlProps_: {},
                    };
                    const innerParent: ParentRenderData =
                        createParentRenderData(
                            {
                                htmlType_: contentType,
                                mdSymbols_: symbolIds,
                            },
                            false,
                        );
                    const innerRemain = parseInline({
                        parseText_: innerText,
                        renderData_: innerParent,
                    });
                    if (innerParent.children_.length) {
                        if (innerRemain) {
                            innerParent.children_.push(
                                createTextRenderData({ text_: innerRemain }),
                            );
                        }
                        const queue = [...innerParent.children_];
                        while (queue.length) {
                            const cur = queue.shift();
                            cur?.mdSymbols_.push(...symbolIds);
                            if (cur?.children_) queue.push(...cur.children_);
                        }
                        contentNode = innerParent;
                    }

                    const group: ParentRenderData = {
                        htmlType_: MarkdownType.Plain,
                        children_: [
                            {
                                htmlType_: MarkdownType.MdSymbol,
                                text_: openText,
                                uuid_: openId,
                                mdSymbols_: symbolIds,
                                htmlProps_: {},
                            },
                            contentNode,
                            {
                                htmlType_: MarkdownType.MdSymbol,
                                text_: closeText,
                                uuid_: closeId,
                                mdSymbols_: symbolIds,
                                htmlProps_: {},
                            },
                        ],
                        uuid_: nanoid8(),
                        mdSymbols_: [],
                        htmlProps_: {},
                    };
                    renderData_.children_.push(group);

                    parseText_ = parseText_.slice(charIndex + fullMatch.length);
                    if (parseText_.length) {
                        return parseInline({
                            parseText_: parseText_,
                            renderData_: renderData_,
                        });
                    }
                    return "";
                }

                // Regular expression to match <any text> links
                const regex = /^<([^>]+)>/;
                const urlRegex = /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i;

                // Get the first matching link
                const match = parseText_.slice(charIndex).match(regex);

                if (match) {
                    const linkText = match[1];
                    if (urlRegex.test(linkText)) {
                        const symbol1Id = nanoid8();
                        const symbol1Text = "<";
                        const symbol2Id = nanoid8();
                        const symbol2Text = ">";

                        const preText = parseText_.slice(0, charIndex);
                        if (preText) {
                            renderData_.children_.push(
                                createTextRenderData({ text_: preText }),
                            );
                        }

                        const parentNodeData: ParentRenderData = {
                            htmlType_: MarkdownType.Link,
                            children_: [],
                            uuid_: nanoid8(),
                            mdSymbols_: [symbol1Id, symbol2Id],
                            htmlProps_: {
                                href: linkText,
                            },
                        };

                        parentNodeData.children_.push({
                            htmlType_: MarkdownType.MdSymbol,
                            text_: symbol1Text,
                            uuid_: symbol1Id,
                            mdSymbols_: [symbol1Id, symbol2Id],
                            htmlProps_: {},
                        });

                        parentNodeData.children_.push({
                            htmlType_: MarkdownType.Plain,
                            text_: linkText,
                            uuid_: nanoid8(),
                            mdSymbols_: [symbol1Id, symbol2Id],
                            htmlProps_: {},
                        });

                        parentNodeData.children_.push({
                            htmlType_: MarkdownType.MdSymbol,
                            text_: symbol2Text,
                            uuid_: symbol2Id,
                            mdSymbols_: [symbol1Id, symbol2Id],
                            htmlProps_: {},
                        });

                        renderData_.children_.push(parentNodeData);

                        // Extract remaining characters and continue processing
                        parseText_ = parseText_.slice(
                            charIndex + linkText.length + 2,
                        );
                        if (parseText_.length) {
                            return parseInline({
                                parseText_: parseText_,
                                renderData_: renderData_,
                            });
                        }
                        return "";
                    }
                }
                break;
            }
            default:
        }
    }

    return parseText_;
};

// Match a bare URL at `start`, returning the URL with trailing punctuation
// trimmed, or null when nothing usable remains (e.g. only the scheme survived).
const matchBareUrl = (source: string, start: number): string | null => {
    const matched = source.slice(start).match(bareUrlReg)?.[0];
    if (!matched) return null;

    const url = trimTrailingUrlPunctuation(matched);
    // Reject when trimming ate everything past the scheme (`https://...`).
    const host = url.replace(URL_SCHEME_REG, "");
    if (!/[a-z0-9]/i.test(host)) return null;

    return url;
};

// Peel trailing chars that are punctuation/CJK rather than part of the URL.
// First any non-ASCII tail is split off (CJK text glued to a URL, e.g.
// `https://x.com的页面`), then ASCII trailing punctuation is trimmed with
// bracket balancing.
const trimTrailingUrlPunctuation = (raw: string): string => {
    let candidate = raw;
    const nonAsciiIndex = [...raw].findIndex((ch) => ch.charCodeAt(0) > 0x7f);
    if (nonAsciiIndex !== -1) {
        candidate = raw.slice(0, nonAsciiIndex);
    }

    let end = candidate.length;
    while (end > 0 && shouldTrimUrlChar(candidate[end - 1], candidate, end - 1)) {
        end -= 1;
    }

    return candidate.slice(0, end);
};

const shouldTrimUrlChar = (
    char: string,
    raw: string,
    index: number,
): boolean => {
    if (!char) return false;

    const open = PAIRED_URL_PUNCTUATION[char];
    if (open) {
        // Trim a closing bracket only when it is unbalanced within the URL.
        const slice = raw.slice(0, index);
        const openCount = countChar(slice, open);
        const closeCount = countChar(slice, char);
        return closeCount >= openCount;
    }

    if (TRAILING_URL_PUNCTUATION.has(char)) return true;

    return char.charCodeAt(0) > 0x7f;
};

const countChar = (text: string, target: string): number => {
    let count = 0;
    for (const ch of text) {
        if (ch === target) count += 1;
    }
    return count;
};

const createMarkdownData = ({
    parseText_,
    renderData_,
    charIndex_,
    symbol_,
    nextSymbolIndex_,
    markdownType_,
    checkDeep_ = false,
    hideSymbol_ = false,
    openText_,
    contentTagName_,
    contentProps_,
}: {
    parseText_: string;
    renderData_: ParentRenderData;
    charIndex_: number;
    symbol_: string;
    nextSymbolIndex_: number;
    markdownType_: MarkdownType;
    checkDeep_?: boolean;
    hideSymbol_?: boolean;
    /** Opening delimiter override when it differs from the closing `symbol_`
     *  (inline rules with a captured `{tag}`: open `=={red}`, close `==`).
     *  The raw text lands in the opening MdSymbol → round-trip stays a
     *  verbatim concat, cursor reveal shows the whole thing. */
    openText_?: string;
    /** Rendered tag for the content node (InlineRuleSpan): lands in
     *  `tagName_`, same contract the HTML-block path uses. */
    contentTagName_?: string;
    /** React props for the content node (InlineRuleSpan): className/style/
     *  href/data-* resolved from the rule + capture. Spread-copied into
     *  htmlProps_ so parse products never share references. */
    contentProps_?: InlineRuleProps;
}) => {
    const open = openText_ ?? symbol_;

    // Extract preceding characters
    const text = parseText_.substring(0, charIndex_);
    if (text.length) {
        renderData_.children_.push(createTextRenderData({ text_: text }));
    }

    // Extract valid code characters
    const inMarkDownText = parseText_.substring(
        charIndex_ + open.length,
        nextSymbolIndex_,
    );

    // Valid markdown range becomes a new group
    const codeGroup = createParentRenderData(
        { htmlType_: MarkdownType.Plain },
        false,
    );
    renderData_.children_.push(codeGroup);

    const mdSymbolBeforeId = nanoid8();
    const mdSymbolBefore: RenderData = {
        htmlType_: hideSymbol_
            ? MarkdownType.MdHideSymbol
            : MarkdownType.MdSymbol,
        text_: open,
        uuid_: mdSymbolBeforeId,
        mdSymbols_: [],
        htmlProps_: {},
    };

    const mdSymbolNextId = nanoid8();

    const mdSymbolNext: RenderData = {
        htmlType_: hideSymbol_
            ? MarkdownType.MdHideSymbol
            : MarkdownType.MdSymbol,
        text_: symbol_,
        uuid_: mdSymbolNextId,
        mdSymbols_: [],
        htmlProps_: {},
    };

    mdSymbolBefore.mdSymbols_.push(mdSymbolBeforeId, mdSymbolNextId);
    mdSymbolNext.mdSymbols_.push(mdSymbolBeforeId, mdSymbolNextId);

    const mdSymbols = new WeakSet();
    mdSymbols.add(mdSymbolBefore);
    mdSymbols.add(mdSymbolNext);

    const symbolIds = [mdSymbolBeforeId, mdSymbolNextId];

    const leafContent: RenderData = {
        htmlType_: markdownType_,
        uuid_: nanoid8(),
        text_: inMarkDownText,
        mdSymbols_: symbolIds,
        ...(contentTagName_ !== undefined ? { tagName_: contentTagName_ } : {}),
        htmlProps_: contentProps_ !== undefined ? { ...contentProps_ } : {},
    };

    // checkDeep_ marks container inlines (em/strong/del/mark): their content
    // may hold nested inline markup, so recurse instead of leaving it literal.
    // Code spans pass checkDeep_=false and stay literal. Mirrors the link
    // branch: parse the content, then push this mark's symbol ids onto every
    // descendant so entering nested text still reveals our wrapping symbols.
    let nextParent: RenderData | ParentRenderData = leafContent;
    if (checkDeep_) {
        const inner: ParentRenderData = {
            htmlType_: markdownType_,
            children_: [],
            uuid_: nanoid8(),
            mdSymbols_: symbolIds,
            ...(contentTagName_ !== undefined
                ? { tagName_: contentTagName_ }
                : {}),
            htmlProps_: contentProps_ !== undefined ? { ...contentProps_ } : {},
        };
        const remainText = parseInline({
            parseText_: inMarkDownText,
            renderData_: inner,
        });

        // Only promote to a container when real nested markup was produced;
        // plain content keeps the leaf shape so the common case (`**foo**`)
        // renders identically to before.
        if (inner.children_.length) {
            if (remainText) {
                inner.children_.push(
                    createTextRenderData({ text_: remainText }),
                );
            }
            const queue = [...inner.children_];
            while (queue.length) {
                const cur = queue.shift();
                cur?.mdSymbols_.push(...symbolIds);
                if (cur?.children_) {
                    queue.push(...cur.children_);
                }
            }
            nextParent = inner;
        }
    }

    codeGroup.children_.push(mdSymbolBefore, nextParent, mdSymbolNext);
};
