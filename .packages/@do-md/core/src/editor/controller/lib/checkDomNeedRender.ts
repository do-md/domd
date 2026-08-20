import { getVisibleDomText } from "./getVisibleDomText";

export const checkNeedRender = (renderParent: HTMLElement | null, ruleTriggerReg: RegExp | null) => {
    if (!renderParent) return false;

    // Heading trigger: 1-6 `#` plus whitespace, and we only render when 0 or 1
    // characters follow. 0 = the user has just typed "# "; 1 = the first character
    // after the space. 2 or more characters must NOT trigger: handleInput runs this
    // on every keystroke, and with the caret inside an already-rendered heading the
    // innerText still starts with "# " (paddingMdSymbols are visible), so a (.*)
    // here would reparse the block on every key.
    // The trailing \s* absorbs the "\n" contributed by the block's filler <br>
    // (innerText is "# a\n", not "# a"); the u flag makes . match by code point, so
    // a leading emoji (a surrogate pair) still counts as a single character.
    const headRegex = /^\s*(#{1,6})\s+.?\s*$/u;

    // Regex matching inline markdown syntax.
    // const markdownRegex =
    //   /(\*\*\*.*?\*\*\*|___.*?___|\*\*.*?\*\*|__.*?__|\*.*?\*|_.*?_|\~\~.*?\~\~|`.*?`|==.*?==)/;

    // const markdownRegex = /(\*\*\*.*?\*\*\*|___.*?___|\*\*.*?\*\*|__.*?__|\*.*?\*|_.*?_|\~\~.*?\~\~|`.*?`|==.*?==|<[^>]+>|!\[.*?\]\([^\s]+\)|\[.*?\]\([^\s]+\))/;
    const markdownRegex =
        /(\*\*\*.*?\*\*\*|___.*?___|\*\*.*?\*\*|__.*?__|\*.*?\*|_.*?_|\~\~.*?\~\~|`.*?`|==.*?==|<[^>]+>|!\[.*?\]\([^\s]*\)|\[.*?\]\([^\s]*\))/;

    // Regex matching a line that starts with "<number>.".
    const numberedListRegex = /^\d+\.\s+/;

    // Regex matching a not-yet-parsed url.
    const urlRegex = /https?:\/\/[^\s<>"'`{}|\\^[\]`]+/;

    // Render-trigger regex for declarative inline rules (generated at
    // compile time from the active set). Without it, rule syntax like
    // `%%x%%` stays literal until the debounced pending fallback, and the
    // cursor replays to the wrong spot when the construct materializes
    // late (the "jjj jumped into the span" incident).
    // const ruleTriggerReg =
    //     this._editorStore_.inlineRules_?.triggerReg_ ?? null;

    // Test the input text against the regexes.
    return (
        (renderParent.innerText.length >= 2 &&
            renderParent.innerText.startsWith("- ")) ||
        (renderParent.innerText.length >= 2 &&
            renderParent.innerText.startsWith("> ")) ||
        getVisibleDomText(renderParent)?.startsWith("```") ||
        getVisibleDomText(renderParent)?.startsWith("[] ") ||
        getVisibleDomText(renderParent)?.startsWith("【】 ") ||
        getVisibleDomText(renderParent)?.startsWith("[ ] ") ||
        getVisibleDomText(renderParent)?.startsWith("[x] ") ||
        headRegex.test(renderParent.innerText) ||
        markdownRegex.test(renderParent.innerText) ||
        (ruleTriggerReg?.test(renderParent.innerText) ?? false) ||
        numberedListRegex.test(renderParent.innerText) ||
        (urlRegex.test(renderParent.innerText) &&
            !renderParent.querySelector("a"))
    );
}