import {
    CursorInfo,
    ParentRenderData,
    RootRenderData,
    Token,
} from "../editor/type";
import { MarkdownType } from "../editor/type/enum";
import { nanoid8 } from "@do-md/utils";
import { parseBlock } from "./parse/parseBlock";
import { parseTableCell } from "./parse/parseTable";
import { CompiledInlineRules } from "./inline-rules";

interface ParseConfig {
    placeholderText_?: string;
    codeTokenizer_?: (code: string, lang?: string) => Token[];
    onCursorFound_?: (cursorInfo: CursorInfo) => void;
    htmlTokenizer_?: (html: string) => Token[];
    /** Compiled inline syntax rules (see data-parse/inline-rules.ts). Optional:
     *  parseInline falls back to COMPILED_DEFAULT_INLINE_RULES, so a call site
     *  that forgets to thread this degrades to legacy `==` behavior. */
    inlineRules_?: CompiledInlineRules;
    /** Opt-in local-file candidate recognition. Every text→tree seam must
     *  thread this through or edit reparses would silently lose FilePath nodes. */
    filePaths_?: boolean;
    /** Set of characters allowed to separate images inside an image group
     *  (see parse/wrapImgGroups.ts). undefined = the wrap pass is off (the
     *  parse output stays node-for-node identical to older versions). Every
     *  text→tree seam has to thread this through, exactly like inlineRules_;
     *  miss one and the reparse output of that path loses its ImgGroup layer
     *  → the model forks. */
    imgGroupSeparators_?: string;
    /** Internal scope, never set by a seam: true while parseInline is parsing
     *  the text of a Markdown link. Links may not contain other links (GFM),
     *  so the autolink recognizers (bare URLs, file paths) stay off there. */
    inLinkText_?: boolean;
}

const stack: ParseConfig[] = [];

export function runWithParseContext<T>(cfg: ParseConfig, fn: () => T): T {
    stack.push(cfg);
    try {
        return fn();
    } finally {
        stack.pop();
    }
}

export function getParseContext(): ParseConfig {
    return stack[stack.length - 1] ?? {};
}

export const parseMarkdown = (
    text: string,
    parseConfig: ParseConfig = {},
): RootRenderData => {
    return runWithParseContext(parseConfig, () => {
        const id = nanoid8();
        const timerLabel = `parseMarkdown:${id}`;
        console.time(timerLabel);
        const renderData: RootRenderData = {
            htmlType_: MarkdownType.Root,
            children_: [],
            uuid_: id,
            mdSymbols_: [],
            htmlProps_: {
                "data-render-id": id,
            },
        };

        try {
            // if (!text) {
            //     renderData.children_.push(createEmptyP());
            //     return renderData;
            // }

            // if (text.startsWith("\n\n")) {
            //     renderData.children_.push(createEmptyP());
            // }

            do {
                text = parseBlock({
                    text_: text,
                    parentRenderData_: renderData,
                    rootRenderData_: renderData,
                });
            } while (text);

            return renderData;
        } finally {
            console.timeEnd(timerLabel);
        }
    });
};

/**
 * The text→tree seam for ONE table cell: an edit inside a cell reparses the
 * cell's paragraph, never the document. `text` is the cell's content in
 * markdown form (`<br>` for a line break — see data-parse/hardBreak.ts); the
 * result is a root holding the single cell paragraph, parsed exactly as
 * parseTable parses every cell. Through parseMarkdown the same text would be
 * read as blocks: `a\n\nb` splits in three, `- x` becomes a list in the cell.
 */
export const parseTableCellMarkdown = (
    text: string,
    parseConfig: ParseConfig = {},
): RootRenderData =>
    runWithParseContext(parseConfig, () => {
        const id = nanoid8();
        const renderData: RootRenderData = {
            htmlType_: MarkdownType.Root,
            children_: [],
            uuid_: id,
            mdSymbols_: [],
            htmlProps_: {
                "data-render-id": id,
            },
        };
        parseTableCell(text, renderData);
        return renderData;
    });
