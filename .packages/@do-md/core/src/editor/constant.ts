import { MarkdownType } from "./type/enum";

export const CursorMarker = "\uE000";

export const ZeroWidthSpace = "\u200B";

export const NonRenderedElements = new Set([
    MarkdownType.LineBr,
    MarkdownType.LineBrBr,
    MarkdownType.MdHideSymbol,
    MarkdownType.OlListSymbol,
    MarkdownType.UlListSymbol,
]);

/** Syntax-symbol leaves (the visible MdSymbol / the DOM-less MdHideSymbol) — they
 *  are chrome, not content. The kernel's single decision point: the format
 *  engine's tokenization, rich-mode caret geometry and the filler check all share
 *  it. */
export const isSymbolType = (t: MarkdownType): boolean =>
    t === MarkdownType.MdSymbol || t === MarkdownType.MdHideSymbol;

/** H1–H6. */
export const HeadingTypes = new Set([
    MarkdownType.H1,
    MarkdownType.H2,
    MarkdownType.H3,
    MarkdownType.H4,
    MarkdownType.H5,
    MarkdownType.H6,
]);

export const HtmlTags: Record<keyof typeof MarkdownType, React.ElementType> = {
    [MarkdownType.Root]: "div",
    [MarkdownType.H1]: "h1",
    [MarkdownType.H2]: "h2",
    [MarkdownType.H3]: "h3",
    [MarkdownType.H4]: "h4",
    [MarkdownType.H5]: "h5",
    [MarkdownType.H6]: "h6",

    [MarkdownType.Blockquote]: "blockquote",

    [MarkdownType.P]: "p",
    [MarkdownType.EmptyP]: "p",

    [MarkdownType.HTML]: "div",

    [MarkdownType.HrDiv]: "div",

    [MarkdownType.Ul]: "ul",
    [MarkdownType.Ol]: "ol",
    [MarkdownType.CheckBoxUl]: "ul",

    [MarkdownType.Table]: "table",
    [MarkdownType.THead]: "thead",
    [MarkdownType.TBody]: "tbody",
    [MarkdownType.TR]: "tr",
    [MarkdownType.TH]: "th",
    [MarkdownType.TD]: "td",

    [MarkdownType.PreEmpty]: "pre",
    [MarkdownType.Pre]: "pre",

    [MarkdownType.Detail]: "details",

    [MarkdownType.Summary]: "summary",

    [MarkdownType.EmptyDetailContent]: "p",

    [MarkdownType.Hr]: "hr",

    [MarkdownType.LiP]: "p",
    [MarkdownType.li]: "li",
    [MarkdownType.CheckBoxLi]: "li",
    [MarkdownType.CheckBoxLabel]: "label",
    [MarkdownType.CheckboxesInput]: "input",
    [MarkdownType.FunctionSymbol]: "span",
    [MarkdownType.FunctionSymbolHide]: "span",
    [MarkdownType.FunctionIcon]: "span",
    [MarkdownType.HideSecondLine]: "span",
    [MarkdownType.Br]: "br",
    [MarkdownType.LineBr]: "div",
    [MarkdownType.LineBrBr]: "div",
    [MarkdownType.InlinePlain]: "span",
    [MarkdownType.Plain]: "span",
    [MarkdownType.Function]: "span",
    [MarkdownType.FunctionTextHide]: "span",
    [MarkdownType.FunctionDel]: "del",
    [MarkdownType.Link]: "a",
    [MarkdownType.EmptyPlain]: "span",
    [MarkdownType.MdSymbol]: "span",
    [MarkdownType.Img]: "img",
    [MarkdownType.ImgGroup]: "span",
    [MarkdownType.MdHideSymbol]: "span",
    [MarkdownType.UlListSymbol]: "span",
    [MarkdownType.OlListSymbol]: "span",
    [MarkdownType.MdFrontSymbol]: "span",
    [MarkdownType.Mark]: "mark",
    // Fallback only — the real tag comes from `tagName_` (InlineRuleSpanElement)
    [MarkdownType.InlineRuleSpan]: "span",
    [MarkdownType.Del]: "del",
    [MarkdownType.Ins]: "ins",
    [MarkdownType.Sub]: "sub",
    [MarkdownType.Sup]: "sup",
    [MarkdownType.U]: "u",
    [MarkdownType.Kbd]: "kbd",
    [MarkdownType.Code]: "code",
    [MarkdownType.PreCode]: "code",
    [MarkdownType.PreCodeEmpty]: "code",
    [MarkdownType.Em]: "em",
    [MarkdownType.Bold]: "span",
    [MarkdownType.EmBold]: "em",
    [MarkdownType.CodeSpanText]: "span",
    [MarkdownType.CodeSpanBrText]: "span",
    [MarkdownType.CodeSpanBlockComment]: "span",
    [MarkdownType.CodeSpanCdata]: "span",
    [MarkdownType.CodeSpanComment]: "span",
    [MarkdownType.CodeSpanDoctype]: "span",
    [MarkdownType.CodeSpanProlog]: "span",
    [MarkdownType.CodeSpanPunctuation]: "span",
    [MarkdownType.CodeSpanAttrName]: "span",
    [MarkdownType.CodeSpanDeleted]: "span",
    [MarkdownType.CodeSpanNamespace]: "span",
    [MarkdownType.CodeSpanTag]: "span",
    [MarkdownType.CodeSpanFunctionName]: "span",
    [MarkdownType.CodeSpanBoolean]: "span",
    [MarkdownType.CodeSpanFunction]: "span",
    [MarkdownType.CodeSpanNumber]: "span",
    [MarkdownType.CodeSpanClassName]: "span",
    [MarkdownType.CodeSpanConst]: "span",
    [MarkdownType.CodeSpanProperty]: "span",
    [MarkdownType.CodeSpanSymbol]: "span",
    [MarkdownType.CodeSpanAtrule]: "span",
    [MarkdownType.CodeSpanBuiltin]: "span",
    [MarkdownType.CodeSpanImportant]: "span",
    [MarkdownType.CodeSpanKeyword]: "span",
    [MarkdownType.CodeSpanSelector]: "span",
    [MarkdownType.CodeSpanAttrValue]: "span",
    [MarkdownType.CodeSpanChar]: "span",
    [MarkdownType.CodeSpanRegex]: "span",
    [MarkdownType.CodeSpanString]: "span",
    [MarkdownType.CodeSpanVariable]: "span",
    [MarkdownType.CodeSpanEntity]: "span",
    [MarkdownType.CodeSpanOperator]: "span",
    [MarkdownType.CodeSpanUrl]: "span",
    [MarkdownType.CodeSpanBold]: "span",
    [MarkdownType.CodeSpanItalic]: "span",
    [MarkdownType.CodeSpanInserted]: "span",
};
