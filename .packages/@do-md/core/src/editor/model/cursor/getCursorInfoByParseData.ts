import { DATA_RENDER_ID } from "../../../data-parse/constant";
import {
    CursorInfo,
    ParentRenderData,
    RenderData,
    RootRenderData,
} from "../../type";

/**
 * End-of-block cursor for the *last* render block in the subtree (uuid + total
 * text length). A more robust range-returning successor already exists —
 * `getCursorRangeByParseData` anchors on the block that actually owns
 * `parseData` rather than on the last one — and call sites are being migrated
 * over; this function retires once they all are.
 */
export const getCursorInfoByParseData = (
    parseData?: RootRenderData | ParentRenderData | RenderData,
): CursorInfo | null => {
    if (!parseData) return null;
    let lastRenderData: RootRenderData | ParentRenderData | RenderData | null =
        null;

    const traverse = function (
        parseData: RootRenderData | ParentRenderData | RenderData,
    ) {
        if (parseData.htmlProps_[DATA_RENDER_ID]) {
            lastRenderData = parseData;
        }
        parseData.children_?.forEach(traverse);
    };

    traverse(parseData);

    if (!lastRenderData) return null;

    let text = "";

    const renderData = lastRenderData as
        | RootRenderData
        | ParentRenderData
        | RenderData;
    const textQueue: (RootRenderData | ParentRenderData | RenderData)[] = [
        renderData,
    ];
    while (textQueue.length) {
        const len = textQueue.length;

        for (let i = 0; i < len; i += 1) {
            const cur = textQueue.shift();

            if (cur?.text_) {
                text += cur.text_;
            }

            cur?.children_?.forEach(
                (child: RootRenderData | ParentRenderData | RenderData) => {
                    textQueue.push(child);
                },
            );
        }
    }

    return {
        uuid: renderData.uuid_,
        offset: text.length,
    };
};
