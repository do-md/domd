/**
 * Headless assertion matrix for the inlineRules v2 engine.
 * Run: npx esbuild scripts/verify-inline-rules/main.ts --bundle --format=esm \
 *        --platform=node --outfile=scripts/verify-inline-rules/out.mjs \
 *      && node scripts/verify-inline-rules/out.mjs
 *
 * DOM-free by construction: only parseMarkdown + the compile module are
 * imported; round-trip is asserted with a local verbatim-concat walker (the
 * same contract toMarkdown relies on).
 *
 * Design doc: project-nexus reference/inline-rules-v2-design.md.
 */
import { parseMarkdown } from "../../src/data-parse/parseMarkdown";
import {
    compileInlineRules,
    defaultInlineRules,
    DATA_INLINE_CAPTURE,
    DATA_INLINE_RULE,
    DATA_INLINE_VARIANT,
} from "../../src/data-parse/inline-rules";
import {
    parseInlineRuleParams,
    scanInlineCapture,
} from "../../src/data-parse/inline-rule-params";
import { InlineRule, ParentRenderData, RenderData } from "../../src/editor/type";
import { isInlineRangeFullyMarked } from "../../src/editor/model/format/isInlineRangeFullyMarked";

type AnyNode = ParentRenderData | RenderData;

let failures = 0;
let passes = 0;

const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
        passes += 1;
    } else {
        failures += 1;
        console.error(`✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
    }
};

/** Verbatim text concat — the round-trip contract for inline content. */
const textOf = (node: AnyNode): string => {
    if (node.children_?.length) {
        return node.children_.map(textOf).join("");
    }
    return node.text_ ?? "";
};

/** Depth-first find by htmlType_. */
const findAll = (node: AnyNode, type: string): AnyNode[] => {
    const out: AnyNode[] = [];
    const walk = (n: AnyNode) => {
        if (n.htmlType_ === (type as AnyNode["htmlType_"])) out.push(n);
        n.children_?.forEach(walk);
    };
    walk(node);
    return out;
};

const parse = (md: string, rules?: InlineRule[]) =>
    parseMarkdown(md, { inlineRules_: compileInlineRules(rules) });

const roundTrip = (md: string, rules?: InlineRule[]) => {
    const tree = parse(md, rules);
    return textOf(tree);
};

const spanOf = (md: string, rules?: InlineRule[]) => {
    const tree = parse(md, rules);
    return findAll(tree, "InlineRuleSpan");
};

// ---------------------------------------------------------------------------
// 0. `{…}` microsyntax — pure-function unit matrix (scanner + parser)
// ---------------------------------------------------------------------------
{
    const scan = (s: string) => scanInlineCapture(s, 0);
    check("scan simple", scan("{red}x")?.raw_ === "red" && scan("{red}x")?.length_ === 5);
    check("scan empty {}", scan("{}")?.raw_ === "" && scan("{}")?.length_ === 2);
    check("scan quoted } inside", scan('{a="x}y"}z')?.raw_ === 'a="x}y"');
    check("scan escaped quote", scan('{a="x\\"y"}')?.raw_ === 'a="x\\"y"');
    check("scan unterminated → null", scan("{red") === null);
    check("scan newline → null", scan("{re\nd}") === null);
    check("scan nested { → null", scan("{a{b}}") === null);
    check("scan not-at-brace → null", scan("x{a}") === null);

    const p = parseInlineRuleParams;
    check("parse empty", JSON.stringify(p("")) === JSON.stringify({ classes: [], named: {}, positional: [] }));
    const full = p('.comment .shiny #anchor bg=red title="a b" red');
    check("parse variant = first dotword", full?.variant === "comment");
    check("parse classes collect all dotwords", JSON.stringify(full?.classes) === '["comment","shiny"]');
    check("parse id", full?.id === "anchor");
    check("parse named bare", full?.named.bg === "red");
    check("parse named quoted keeps space", full?.named.title === "a b");
    check("parse positional", JSON.stringify(full?.positional) === '["red"]');
    check("parse quoted escapes", p('t="a\\"b\\\\c"')?.named.t === 'a"b\\c');
    check("parse two ids → later wins", p("#a #b")?.id === "b");
    check("parse bad dotword → null", p(".9x") === null);
    check("parse empty value → null", p("k=") === null);
    check("parse unquoted quote → null", p("k='v'") === null);
    check("parse bad bare → null", p('a"b') === null);
}

// ---------------------------------------------------------------------------
// 1. Default rules — `==` behaves exactly like the old hardcoded Mark
// ---------------------------------------------------------------------------
{
    const spans = spanOf("a ==hi== b");
    check("default == produces one InlineRuleSpan", spans.length >= 1);
    check("default == tagName is mark", spans[0]?.tagName_ === "mark");
    check("default == round-trip", roundTrip("a ==hi== b") === "a ==hi== b");
    check(
        "default == carries data-inline-rule",
        spans[0]?.htmlProps_?.[DATA_INLINE_RULE] === "==",
    );

    check("legacy ===x=== round-trip", roundTrip("===x===") === "===x===");
    const l = spanOf("===x===");
    check("legacy ===x=== marks '=x'", l.length >= 1 && textOf(l[0]) === "=x");

    check("setext guard: ==== stays literal", spanOf("====").length === 0);
    check("setext guard: ===== stays literal", spanOf("=====").length === 0);
    check("'== ==' (space content) matches", spanOf("== ==").length === 1);
    check("spaces allowed in ==: '==a b==' marks", spanOf("==a b==").length === 1);

    const seq = spanOf("=x==y==");
    check("=x==y== marks y", seq.length === 1 && textOf(seq[0]) === "y");
    check("=x==y== round-trip", roundTrip("=x==y==") === "=x==y==");

    check("escape \\==x== stays unmarked", spanOf("\\==x== ok").length === 0);
    check("escape round-trip", roundTrip("\\==x== ok") === "\\==x== ok");

    const nested = parse("==**bold**==");
    check("nested bold inside ==", findAll(nested, "Bold").length === 1);
    check("nested round-trip", textOf(nested) === "==**bold**==");
}

// ---------------------------------------------------------------------------
// 2. Custom rules — the four syntaxes from do-md/domd#13, v2 shapes
// ---------------------------------------------------------------------------
const paulRules: InlineRule[] = [
    ...defaultInlineRules,
    { open: "^", close: "^", exactLen: true, allowSpace: false, tagName: "sup" },
    { open: "~", close: "~", exactLen: true, allowSpace: false, tagName: "sub" },
    {
        open: "!!",
        close: "!!",
        exactLen: true,
        tagName: "span",
        className: "custom-span",
        attrs: { class: "{}" },
    },
];

{
    const sup = spanOf("E = mc^2^ ok", paulRules);
    check("^2^ superscript", sup.length === 1 && sup[0].tagName_ === "sup");
    check("^2^ content", textOf(sup[0]) === "2");
    check("^2^ round-trip", roundTrip("E = mc^2^ ok", paulRules) === "E = mc^2^ ok");

    check("^^x^ exactLen literal", spanOf("^^x^", paulRules).length === 0);
    check("^x^^ exactLen literal", spanOf("^x^^", paulRules).length === 0);
    check("^a b^ no-space literal", spanOf("^a b^", paulRules).length === 0);
    check("escape \\^x^ literal", spanOf("\\^x^", paulRules).length === 0);

    const sub = spanOf("H~2~O", paulRules);
    check("~2~ subscript", sub.length === 1 && sub[0].tagName_ === "sub");
    check("~2~ round-trip", roundTrip("H~2~O", paulRules) === "H~2~O");

    // Single-~ rule must NOT shadow builtin ~~del~~
    const delTree = parse("a ~~gone~~ b", paulRules);
    check("~~del~~ still Del", findAll(delTree, "Del").length === 1);
    check(
        "~~del~~ not captured by ~ rule",
        findAll(delTree, "InlineRuleSpan").length === 0,
    );
    check("~~del~~ round-trip", textOf(delTree) === "a ~~gone~~ b");
    check(
        "mixed sub+del round-trip",
        roundTrip("x~1~ and ~~y~~", paulRules) === "x~1~ and ~~y~~",
    );

    // `!!` rule coexists with image syntax (BUILTIN_NEXT_CHAR yield):
    const bang = spanOf("!!{note}styled!!", paulRules);
    check("!!{note}x!! matches", bang.length === 1);
    check(
        "!!{note}x!! className via attrs class template",
        bang[0]?.htmlProps_?.className === "custom-span note",
        bang[0]?.htmlProps_,
    );
    check(
        "!!{note}x!! round-trip",
        roundTrip("!!{note}styled!!", paulRules) === "!!{note}styled!!",
    );
    const imgTree = parse("look ![alt](http://x.com/a.png) end", paulRules);
    check("![alt](url) still an image", findAll(imgTree, "Img").length === 1);
    check(
        "image not captured by !! rule",
        findAll(imgTree, "InlineRuleSpan").length === 0,
    );
    const doubleBang = parse("!![alt](http://x.com/a.png)", paulRules);
    check(
        "!![alt](url) → literal ! + image",
        findAll(doubleBang, "Img").length === 1 &&
            findAll(doubleBang, "InlineRuleSpan").length === 0,
    );
    check(
        "!![alt](url) round-trip",
        textOf(doubleBang) === "!![alt](http://x.com/a.png)",
    );
}

// ---------------------------------------------------------------------------
// 3. `{…}` params → attrs templates / variants / metadata
// ---------------------------------------------------------------------------
{
    // Positional param via `{}` placeholder — the v1 color-template use case.
    const styleRules: InlineRule[] = [
        {
            open: "==",
            close: "==",
            tagName: "mark",
            className: "custom-highlight",
            attrs: { style: "background-color: {}" },
        },
    ];
    const st = spanOf("=={red}text==", styleRules);
    check("=={red} matches (style)", st.length === 1);
    check(
        "=={red} style object",
        (st[0]?.htmlProps_?.style as any)?.backgroundColor === "red",
        st[0]?.htmlProps_,
    );
    check(
        "=={red} keeps base className",
        st[0]?.htmlProps_?.className === "custom-highlight",
    );
    check(
        "=={red} round-trip keeps capture text",
        roundTrip("=={red}text==", styleRules) === "=={red}text==",
    );
    check(
        "=={#8888ff} hex is a positional (# needs word chars) → id-invalid → capture void",
        spanOf("=={#8888ff}x==", styleRules).length === 1,
    );

    // Named params via `{key}` placeholders (multi-param template)
    const namedRules: InlineRule[] = [
        {
            open: "==",
            close: "==",
            tagName: "mark",
            attrs: {
                style: "background-color: color-mix(in srgb, {bg} 80%, transparent); border-radius: {r}",
            },
        },
    ];
    const named = spanOf("=={bg=red r=2px}x==", namedRules)[0]?.htmlProps_
        ?.style as any;
    check(
        "named params multi-substitution",
        named?.backgroundColor ===
            "color-mix(in srgb, red 80%, transparent)" &&
            named?.borderRadius === "2px",
        named,
    );
    // Missing key voids the whole attr — never half-substituted
    const missing = spanOf("=={bg=red}x==", namedRules);
    check("missing {r} voids style attr", missing[0]?.htmlProps_?.style === undefined);
    check("missing {r} still matches + round-trips", missing.length === 1 && roundTrip("=={bg=red}x==", namedRules) === "=={bg=red}x==");

    // No capture → base props only
    const plain = spanOf("==text==", styleRules);
    check("== without {…} still matches", plain.length === 1);
    check("== without {…} has no style", plain[0]?.htmlProps_?.style === undefined);

    // `.word`s land as classes (degrade path for unregistered variants)
    const cls = spanOf("=={.a .b}x==", styleRules);
    check(
        "dotwords land as classes",
        cls[0]?.htmlProps_?.className === "custom-highlight a b",
        cls[0]?.htmlProps_,
    );
    check(
        "unregistered variant recorded as data attr",
        cls[0]?.htmlProps_?.[DATA_INLINE_VARIANT] === "a",
    );

    // `#id` → id prop
    check("id param lands", spanOf("=={#anchor1}x==", styleRules)[0]?.htmlProps_?.id === "anchor1");

    // Quoted value with `}` inside survives scan + round-trip
    const tricky = '=={t="a}b"}x==';
    const trickySpan = spanOf(tricky, [
        { open: "==", close: "==", tagName: "mark", attrs: { title: "{t}" } },
    ]);
    check("quoted } inside capture matches", trickySpan.length === 1);
    check("quoted } title value", trickySpan[0]?.htmlProps_?.title === "a}b");
    check(
        "quoted } round-trip verbatim",
        roundTrip(tricky, [
            { open: "==", close: "==", tagName: "mark", attrs: { title: "{t}" } },
        ]) === tricky,
    );

    // href sanitizing through attrs
    const hrefRules: InlineRule[] = [
        { open: "%%", close: "%%", tagName: "span", attrs: { href: "{}" } },
    ];
    check(
        "href javascript: blocked",
        spanOf("%%{javascript:alert(1)}x%%", hrefRules)[0]?.htmlProps_?.href ===
            undefined,
    );
    check(
        "href normal url passes",
        spanOf("%%{https://x.com}x%%", hrefRules)[0]?.htmlProps_?.href ===
            "https://x.com",
    );

    // data-* target
    check(
        "data-note attr target",
        spanOf("%%{hello}x%%", [
            { open: "%%", close: "%%", tagName: "span", attrs: { "data-note": "{}" } },
        ])[0]?.htmlProps_?.["data-note"] === "hello",
    );

    // Variant dispatch
    const variantRules: InlineRule[] = [
        {
            open: "==",
            close: "==",
            tagName: "mark",
            variants: {
                comment: {
                    tagName: "q",
                    className: "note-box",
                    parseInner: false,
                },
            },
        },
    ];
    const vDefault = spanOf("==x==", variantRules);
    check("variant: no .word → default tag", vDefault[0]?.tagName_ === "mark");
    const vHit = spanOf("=={.comment author=w}被批注==", variantRules);
    check("variant hit → variant tag", vHit[0]?.tagName_ === "q");
    check(
        "variant hit → variant className + dotword class",
        vHit[0]?.htmlProps_?.className === "note-box comment",
        vHit[0]?.htmlProps_,
    );
    check(
        "variant recorded as data attr",
        vHit[0]?.htmlProps_?.[DATA_INLINE_VARIANT] === "comment",
    );
    check(
        "variant round-trip",
        roundTrip("=={.comment author=w}被批注==", variantRules) ===
            "=={.comment author=w}被批注==",
    );
    const vMiss = spanOf("=={.other}x==", variantRules);
    check("unregistered variant → default tag + class degrade", vMiss[0]?.tagName_ === "mark" && vMiss[0]?.htmlProps_?.className === "other");

    // Component channel: rawCapture is persisted for render-time dispatch
    const compRules: InlineRule[] = [
        {
            open: "==",
            close: "==",
            tagName: "mark",
            component: (() => null) as any,
        },
    ];
    check(
        "component rule persists data-inline-capture",
        spanOf("=={.x k=v}y==", compRules)[0]?.htmlProps_?.[
            DATA_INLINE_CAPTURE
        ] === ".x k=v",
    );

    // Malformed capture counts as absent → literal content, round-trip holds
    const bad = spanOf("=={k=}x==", styleRules);
    check("malformed capture → still matches without params", bad.length === 1);
    check("malformed capture text stays in content", textOf(bad[0]) === "{k=}x");
    check("malformed capture round-trip", roundTrip("=={k=}x==", styleRules) === "=={k=}x==");
}

// ---------------------------------------------------------------------------
// 4. Reserved delimiters — capture disambiguation + longest-prefix precedence
// ---------------------------------------------------------------------------
{
    // `<` mention rule — the do-md mention commit shape
    const mentionRules: InlineRule[] = [
        ...defaultInlineRules,
        {
            open: "<",
            close: ">",
            tagName: "span",
            className: "mention",
            attrs: { "data-mention-id": "{id}" },
        },
    ];
    const mention = spanOf("hi <{.mention id=11}王金涛> ok", mentionRules);
    check("<{.mention id=11}王金涛> matches", mention.length === 1);
    check("mention content", textOf(mention[0]) === "王金涛");
    check(
        "mention data-mention-id",
        mention[0]?.htmlProps_?.["data-mention-id"] === "11",
    );
    check(
        "mention round-trip",
        roundTrip("hi <{.mention id=11}王金涛> ok", mentionRules) ===
            "hi <{.mention id=11}王金涛> ok",
    );
    // Block-path encounter: the mention at line start must not be swallowed
    // by the HTML block parser (`<{` is not a tag start).
    check(
        "mention at line start round-trips",
        roundTrip("<{.mention id=1}王金涛> hello", mentionRules) ===
            "<{.mention id=1}王金涛> hello",
    );
    const autolink = parse("see <https://x.com> end", mentionRules);
    check("autolink <url> still a Link", findAll(autolink, "Link").length === 1);
    check(
        "autolink not captured by < rule",
        findAll(autolink, "InlineRuleSpan").length === 0,
    );
    check(
        "autolink round-trip with < rule",
        textOf(autolink) === "see <https://x.com> end",
    );
    const inlineHtml = parse("a <u>under</u> b", mentionRules);
    check("inline <u> still parses as U", findAll(inlineHtml, "U").length === 1);
    check(
        "inline html round-trip with < rule",
        textOf(inlineHtml) === "a <u>under</u> b",
    );

    // `[[` wikilink — longest-prefix precedence over the builtin `[` link
    const wikiRules: InlineRule[] = [
        ...defaultInlineRules,
        { open: "[[", close: "]]", tagName: "span", className: "wikilink" },
    ];
    const wiki = spanOf("go [[note name]] now", wikiRules);
    check("[[note name]] matches", wiki.length === 1);
    check("wikilink content", textOf(wiki[0]) === "note name");
    check(
        "wikilink round-trip",
        roundTrip("go [[note name]] now", wikiRules) === "go [[note name]] now",
    );
    const mdLink = parse("a [text](http://u.com) b", wikiRules);
    check("[text](url) still a Link", findAll(mdLink, "Link").length === 1);
    check(
        "md link not captured by [[ rule",
        findAll(mdLink, "InlineRuleSpan").length === 0,
    );
    check(
        "md link round-trip with [[ rule",
        textOf(mdLink) === "a [text](http://u.com) b",
    );
    // Documented opt-in shadowing: [[a]](b) → wikilink + literal (b)
    const shadow = parse("[[a]](b)", wikiRules);
    check(
        "[[a]](b) → wikilink wins, (b) literal",
        findAll(shadow, "InlineRuleSpan").length === 1 &&
            findAll(shadow, "Link").length === 0,
    );
    check("[[a]](b) round-trip", textOf(shadow) === "[[a]](b)");

    // `*` rule — capture-only disambiguation vs greedy em/bold
    const starRules: InlineRule[] = [
        { open: "*", close: "*", tagName: "b", className: "star" },
    ];
    const star = spanOf("*{.x}y*", starRules);
    check("*{.x}y* fires the * rule", star.length === 1);
    check("* rule round-trip", roundTrip("*{.x}y*", starRules) === "*{.x}y*");
    const em = parse("a *y* b", starRules);
    check("*y* without capture stays Em", findAll(em, "Em").length === 1);
    check("*y* not captured by * rule", findAll(em, "InlineRuleSpan").length === 0);
    const bold = parse("**y**", starRules);
    check("**y** stays Bold", findAll(bold, "Bold").length === 1);

    // `~~` rule — capture-only disambiguation vs Del
    const tildeRules: InlineRule[] = [
        { open: "~~", close: "~~", tagName: "span", className: "wavy" },
    ];
    check("~~{.x}y~~ fires the ~~ rule", spanOf("~~{.x}y~~", tildeRules).length === 1);
    const del = parse("~~y~~", tildeRules);
    check("~~y~~ without capture stays Del", findAll(del, "Del").length === 1);
    check("~~y~~ not captured", findAll(del, "InlineRuleSpan").length === 0);
}

// ---------------------------------------------------------------------------
// 5. Compile-time validation — Tier 0 + structural checks
// ---------------------------------------------------------------------------
{
    const compiled = compileInlineRules([
        { open: "`", close: "`", tagName: "b" }, // Tier 0 → dropped
        { open: "\\", close: "\\", tagName: "b" }, // Tier 0 → dropped
        { open: "{", close: "}", tagName: "b" }, // Tier 0 → dropped
        { open: "a", close: "a", tagName: "b" }, // alnum → dropped
        { open: "", close: "^", tagName: "b" }, // empty → dropped
        { open: "^", close: "^", tagName: "script" }, // bad tag → span
    ]);
    check("Tier0 ` dropped", !compiled.byChar_.has("`"));
    check("Tier0 \\ dropped", !compiled.byChar_.has("\\"));
    check("Tier0 { dropped", !compiled.byChar_.has("{"));
    check("alnum a dropped", !compiled.byChar_.has("a"));
    const supBucket = compiled.byChar_.get("^");
    check("empty-open dropped, bad-tag kept", supBucket?.length === 1);
    check("script tag downgraded to span", supBucket?.[0].render_.tagName_ === "span");

    // Reserved-collision policy → requiresCapture flags
    const flags = compileInlineRules([
        { open: "<", close: ">", tagName: "span" },
        { open: "[[", close: "]]", tagName: "span" },
        { open: "*", close: "*", tagName: "b" },
        { open: "~~", close: "~~", tagName: "s" },
        { open: "~", close: "~", tagName: "sub" },
    ]);
    check("< requiresCapture", flags.byOpen_.get("<")?.requiresCapture_ === true);
    check("[[ free (longest-prefix)", flags.byOpen_.get("[[")?.requiresCapture_ === false);
    check("* requiresCapture", flags.byOpen_.get("*")?.requiresCapture_ === true);
    check("~~ requiresCapture", flags.byOpen_.get("~~")?.requiresCapture_ === true);
    check("single ~ free (runtime run yield)", flags.byOpen_.get("~")?.requiresCapture_ === false);
    check(
        "~ bucket sorted longest first",
        flags.byChar_.get("~")?.[0]?.open_ === "~~",
    );

    // `[[` is a RUN of `[` (single char repeated) → run semantics, default
    // non-exact like `==`. Genuinely mixed-char delimiters force exact.
    check("[[ is run-shaped, non-exact by default", flags.byOpen_.get("[[")?.exactLen_ === false);
    const mixed = compileInlineRules([
        { open: ":-", close: "-:", tagName: "span" },
    ]);
    check("mixed :- forces exactLen", mixed.byOpen_.get(":-")?.exactLen_ === true);
    check(
        "mixed asymmetric delimiters match",
        spanOf("a :-x-: b", [
            { open: ":-", close: "-:", tagName: "span" },
        ]).length === 1,
    );
    check(
        "mixed asymmetric round-trip",
        roundTrip("a :-x-: b", [
            { open: ":-", close: "-:", tagName: "span" },
        ]) === "a :-x-: b",
    );

    // attrs target validation
    const badAttr = compileInlineRules([
        { open: "%%", close: "%%", tagName: "span", attrs: { onclick: "{}" } },
    ]);
    check(
        "attrs onclick target dropped",
        badAttr.byOpen_.get("%%")?.render_.attrs_ === undefined,
    );

    // Duplicate open — later wins
    const dup = compileInlineRules([
        { open: "%%", close: "%%", tagName: "span" },
        { open: "%%", close: "%%", tagName: "mark" },
    ]);
    check(
        "duplicate open → later wins",
        dup.byOpen_.get("%%")?.render_.tagName_ === "mark" &&
            dup.byChar_.get("%")?.length === 1,
    );

    check("no == rule → hasHighlight false", compiled.hasHighlight_ === false);
    check(
        "defaults → hasHighlight true",
        compileInlineRules(undefined).hasHighlight_ === true,
    );
    check("rules=[] leaves == literal", spanOf("==x==", []).length === 0);
    check("rules=[] round-trip", roundTrip("==x==", []) === "==x==");
}

// ---------------------------------------------------------------------------
// 6. parseInner=false — literal content (rule level + variant override)
// ---------------------------------------------------------------------------
{
    const litRules: InlineRule[] = [
        { open: "==", close: "==", tagName: "mark", parseInner: false },
    ];
    const tree = parse("==**x**==", litRules);
    check("parseInner=false: no nested Bold", findAll(tree, "Bold").length === 0);
    check("parseInner=false round-trip", textOf(tree) === "==**x**==");

    const variantLit: InlineRule[] = [
        {
            open: "==",
            close: "==",
            tagName: "mark",
            variants: { raw: { parseInner: false } },
        },
    ];
    check(
        "variant parseInner=false: no nested Bold",
        findAll(parse("=={.raw}**x**==", variantLit), "Bold").length === 0,
    );
    check(
        "default variant still parses inner",
        findAll(parse("==**x**==", variantLit), "Bold").length === 1,
    );
}

// ---------------------------------------------------------------------------
// 7. Format engine — highlight toggle still detects rule-produced `==` spans
// ---------------------------------------------------------------------------
{
    const block = parse("a ==x== b").children_[0];
    check(
        "highlight detected inside == span (strip direction)",
        isInlineRangeFullyMarked(block, 4, 5, "highlight") === true,
    );
    check(
        "no highlight outside == span (add direction)",
        isInlineRangeFullyMarked(block, 0, 1, "highlight") === false,
    );
    const supBlock = parse("a ^2^ b", [
        ...defaultInlineRules,
        { open: "^", close: "^", exactLen: true, allowSpace: false, tagName: "sup" },
    ]).children_[0];
    check(
        "sup span does not read as highlight",
        isInlineRangeFullyMarked(supBlock, 3, 4, "highlight") === false,
    );
}

// ---------------------------------------------------------------------------
// 8. Render-trigger regex — checkRender_ must fire the moment a construct
//    closes; reserved-char rules only fire with the mandatory capture part.
// ---------------------------------------------------------------------------
{
    const compiled = compileInlineRules([
        ...defaultInlineRules,
        { open: "^", close: "^", exactLen: true, allowSpace: false, tagName: "sup" },
        { open: "%%", close: "%%", tagName: "span", className: "custom-span" },
        { open: "<", close: ">", tagName: "span", className: "mention" },
    ]);
    const reg = compiled.triggerReg_!;
    check("triggerReg exists", reg instanceof RegExp);
    check("triggerReg fires on ==x==", reg.test("a ==x== b"));
    check("triggerReg fires on ^2^", reg.test("mc^2^"));
    check("triggerReg fires on %%x%%", reg.test("%%x%%"));
    check("triggerReg fires on %%{red}x%%", reg.test("%%{red}sample%%"));
    check("triggerReg fires on <{.mention}x>", reg.test("hi <{.mention id=1}王金涛>"));
    check("triggerReg quiet on <https://x> (capture mandatory)", !reg.test("see <https://x.com> end"));
    check("triggerReg quiet on plain text", !reg.test("just words here"));
    check("triggerReg quiet on single %", !reg.test("50% of 20%"));
    check("no-space rule: '^a b^' does not fire", !reg.test("^a b^"));
    check("rules=[] → no trigger regex", compileInlineRules([]).triggerReg_ === null);
}

// ---------------------------------------------------------------------------
// 9. Fallback — no ParseConfig at all still parses == (missed-call-site guard)
// ---------------------------------------------------------------------------
{
    const tree = parseMarkdown("a ==hi== b");
    check(
        "no-config fallback still highlights",
        findAll(tree, "InlineRuleSpan").length === 1,
    );
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
