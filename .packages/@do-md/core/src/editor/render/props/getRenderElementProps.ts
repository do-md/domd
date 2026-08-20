import styles from "../../style/DOMD.module.css";
import { AnyRenderData } from "../../type";

// These 34 CodeSpan highlight classes used to be a hand-written type →
// "token xxx" lookup table, in which the key suffix (BlockComment) and the
// value suffix (block-comment) stored the same data twice. Now only the
// PascalCase suffix is stored and the class is derived at runtime:
// className = "token " + kebab(suffix), with Const→constant as the sole
// exception. A script verified entry by entry that the derived results match
// the old table 100%.
const CODE_SPAN_SUFFIXES =
    "BlockComment Cdata Comment Doctype Prolog Punctuation AttrName Deleted Namespace Tag FunctionName Boolean Function Number ClassName Const Property Symbol Atrule Builtin Important Keyword Selector AttrValue Char Regex String Variable Entity Operator Url Bold Italic Inserted";

const ClassNameMap: Record<string, string> = {};
for (const suffix of CODE_SPAN_SUFFIXES.split(" ")) {
    const token =
        suffix === "Const"
            ? "constant"
            : suffix.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    ClassNameMap["CodeSpan" + suffix] = "token " + token;
}

/** The shared render props of a node: htmlProps passed through, plus the CSS
 *  module class name and the CodeSpan highlight class merged in. The two
 *  suppress* keys are React-specific (part of the public API contract — host
 *  components spread this) — when a second framework is supported, that
 *  framework's adapter layer strips or translates them; nothing changes
 *  here. */
export const getRenderElementProps = (
    parsedData: AnyRenderData,
) => {
    const { className: _, ...restHtmlProps } = parsedData.htmlProps_ || {};

    const additionalClassName = ClassNameMap[
        parsedData.htmlType_ as keyof typeof ClassNameMap
    ]
        ? ClassNameMap[parsedData.htmlType_ as keyof typeof ClassNameMap]
        : "";

    const mergedClassName = [
        styles[parsedData.htmlType_] || "",
        additionalClassName,
        parsedData.htmlProps_?.className || "",
    ]
        .filter(Boolean)
        .join(" ");

    return {
        suppressHydrationWarning: true,
        suppressContentEditableWarning: true,
        ...restHtmlProps,
        className: mergedClassName,
    };
};
