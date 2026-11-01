import type { AnyRenderData, FilePathInfo, FilePathKind } from "../../type";
import { MarkdownType } from "../../type/enum";
import { toMarkdown } from "../serialize/toMarkdown";

const KINDS = new Set<FilePathKind>([
    "absolute",
    "home",
    "relative",
    "file-uri",
]);

/** Read the stable public payload of a FilePath render node. */
export const getFilePathInfo = (
    parsedData: AnyRenderData,
): FilePathInfo | null => {
    if (parsedData.htmlType_ !== MarkdownType.FilePath) return null;
    const path = parsedData.htmlProps_["data-file-path"];
    const kind = parsedData.htmlProps_["data-file-path-kind"];
    if (typeof path !== "string" || typeof kind !== "string") return null;
    if (!KINDS.has(kind as FilePathKind)) return null;

    const lineValue = parsedData.htmlProps_["data-file-line"];
    const columnValue = parsedData.htmlProps_["data-file-column"];
    return {
        raw: toMarkdown(parsedData),
        path,
        kind: kind as FilePathKind,
        ...(typeof lineValue === "number" ? { line: lineValue } : {}),
        ...(typeof columnValue === "number" ? { column: columnValue } : {}),
    };
};
