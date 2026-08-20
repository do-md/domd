import { TextOperator } from "../../model/text/TextOperator";
import { getClosestRenderDom } from "./getClosestRenderDom";
import { getDomByCursor } from "./getDomByCursor";
import { getIdByRenderDom } from "./getIdByRenderDom";
import { getSelectCurPosByDom } from "./getSelectCurPosByDom";
import { getVisibleDomText } from "./getVisibleDomText";

export const checkAutofill = (text: string, textAreaDom: HTMLDivElement) => {
    if (text === "~" || text === "=") {
        const [start, end] = getSelectCurPosByDom(textAreaDom);
        if (start !== end) {
            const startNode = getDomByCursor(textAreaDom, start);
            if (!startNode.node?.parentNode) return null;
            const startRenderParent = getClosestRenderDom(
                startNode.node.parentNode as HTMLElement,
            );
            const endNode = getDomByCursor(textAreaDom, end);
            if (!endNode.node?.parentNode) return null;
            const endRenderParent = getClosestRenderDom(
                endNode.node.parentNode as HTMLElement,
            );

            if (
                startRenderParent &&
                startRenderParent === endRenderParent
            ) {
                const oldText = getVisibleDomText(startRenderParent) || "";
                const [startInparent, endInParent] =
                    getSelectCurPosByDom(startRenderParent);
                const newText = TextOperator.of(oldText).wrap(startInparent, endInParent, text.repeat(2)).text

                const uuid = getIdByRenderDom(startRenderParent);
                if (uuid) {
                    return { uuid, text: newText, curPos: end + 2 };
                }
            }
        }
    } else if (
        text === "*" ||
        text == "`" ||
        text == "~~" ||
        text == "=="
    ) {
        const [start, end] = getSelectCurPosByDom(textAreaDom);
        if (start !== end) {
            const startNode = getDomByCursor(textAreaDom, start);
            if (!startNode.node?.parentNode) return null;
            const startRenderParent = getClosestRenderDom(
                startNode.node.parentNode as HTMLElement,
            );
            const endNode = getDomByCursor(textAreaDom, end);
            if (!endNode.node?.parentNode) return null;
            const endRenderParent = getClosestRenderDom(
                endNode.node.parentNode as HTMLElement,
            );

            if (
                startRenderParent &&
                startRenderParent === endRenderParent
            ) {
                const oldText = getVisibleDomText(startRenderParent) || "";
                const [startInparent, endInParent] =
                    getSelectCurPosByDom(startRenderParent);
                const newText = TextOperator.of(oldText).wrap(startInparent, endInParent, text).text
                const uuid = getIdByRenderDom(startRenderParent);
                if (uuid) {
                    return {
                        uuid,
                        text: newText,
                        curPos: end + text.length,
                    };
                }
            }
        }
    }

    return null;
}