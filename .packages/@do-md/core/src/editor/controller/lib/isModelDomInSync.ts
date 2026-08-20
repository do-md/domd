import { ParentRenderData } from "../../type";
import { modelBlockText } from "../../model/rich/modelBlockText";
import { getVisibleDomText } from "./getVisibleDomText";

/** The single spelling of the model↔DOM consistency guard. Every mixed
 *  "DOM offset × model structure" decision (input takeover / Enter offset
 *  normalization / planRichBackspace) must go through it first: when the two
 *  disagree (a pending input is still in flight), deciding a boundary against the
 *  lagging model is guaranteed to land in the wrong place.
 *  It lives in controller/lib rather than model/rich because it reads the DOM
 *  (getVisibleDomText) while the model layer is DOM-free; controller/lib is the home
 *  of DOM-facing helpers, so this is its final address. */
export const isModelDomInSync = (
    renderData: ParentRenderData,
    renderElement: Node | null | undefined,
): boolean => modelBlockText(renderData) === getVisibleDomText(renderElement);
