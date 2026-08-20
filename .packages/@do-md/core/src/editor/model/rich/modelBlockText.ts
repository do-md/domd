import { ParentRenderData } from "../../type";
import { flattenLeaves } from "./flattenLeaves";

/** The block's model text (leaf `text_` concatenated in order). Being equal to
 *  getVisibleDomText(renderElement) is the precondition for every rich-mode
 *  boundary decision: during fast typing, while pending input has not been
 *  applied yet, the model lags the DOM, and answering "is the DOM cursor
 *  adjacent to a symbol?" from the lagging model's leaf structure is
 *  guaranteed to be off. (The guard itself, isModelDomInSync, lives in
 *  controller/lib — it reads the DOM, so it does not belong to the model
 *  layer; controller/lib is the home of DOM-related methods.) */
export const modelBlockText = (renderData: ParentRenderData): string => {
    let out = "";
    for (const l of flattenLeaves(renderData)) out += l.data_.text_ ?? "";
    return out;
};
