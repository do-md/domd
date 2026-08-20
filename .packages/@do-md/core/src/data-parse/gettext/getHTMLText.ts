// Tags handled by the inline parser (parseInline). A BARE `<tag>…</tag>` must
// fall through to the paragraph/inline path so hidden md-symbol wrapping
// kicks in. Versions with attributes (`<ins class="x">…</ins>`) stay on the
// block path for backward compatibility — attrs would otherwise be lost.
// Keep in sync with INLINE_TAG_TO_TYPE in parse/parseInline.ts.
const INLINE_HTML_TAGS = new Set(["ins", "sub", "sup", "u", "kbd", "mark"]);

export function extractLeadingHtmlBlocks(text: string) {
    // Bail early when the line leads with a bare inline tag (no attrs),
    // letting parseInline own it.
    const bareInline = text.match(/^\s*<([a-zA-Z][\w-]*)>/);
    if (bareInline && INLINE_HTML_TAGS.has(bareInline[1].toLowerCase())) {
        return null;
    }
    // Check if it starts with a valid HTML tag (tag name must start with a letter)
    // This excludes plain text in angle brackets like <some text> or <3
    if (!text.match(/^\s*<[a-zA-Z]/)) return null;
    // Block HTML is recognized in three shapes only:
    //   1. Paired tag:          <tag …>…</tag>
    //   2. Void element bare:   <br>, <hr>, <img …>, …  (HTML5 void list)
    //   3. Explicit self-close: <tag …/>
    // Notably NOT recognized: a lone `<a>` / `<div>` with no close — those
    // are extremely common mid-typing states in a WYSIWYG editor and would
    // otherwise hijack the paragraph as soon as the user closes the bracket.
    const regex =
        /^\s*(<([a-zA-Z][\w-]*)[^>]*>([\s\S]*?)<\/\2>|<(?:br|hr|img|input|meta|link|col|area|base|embed|source|track|wbr)\b[^>]*>|<[a-zA-Z][\w-]*[^>]*\/>)/;
    let result = '';
    let match;
    let lastIndex = 0;

    // Loop to find all matching tags
    while ((match = regex.exec(text.substring(lastIndex))) !== null) {
        result += match[0]; // Add each matched tag to the result
        lastIndex += match.index + match[0].length;
    }

    return result;
}