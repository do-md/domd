import { DATA_SPAN_RENDER_ID } from "../../../data-parse/constant";
import { AnyRenderData } from "../../type";

/** DOM props marking a CONTENT text leaf with its model uuid (the
 *  DATA_SPAN_RENDER_ID public contract). Null for parents and non-text
 *  elements. Spread AFTER the shared render props so the marker cannot be
 *  clobbered by htmlProps. */
export const getSpanRenderIdProps = (
    parsedData: AnyRenderData,
): Record<string, string> | null =>
    !parsedData.children_?.length && parsedData.text_ !== undefined
        ? { [DATA_SPAN_RENDER_ID]: parsedData.uuid_ }
        : null;
