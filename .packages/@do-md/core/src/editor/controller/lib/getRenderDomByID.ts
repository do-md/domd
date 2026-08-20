import { DATA_RENDER_ID } from "../../../data-parse/constant";

/**
 * Resolve a render DOM element by its uuid.
 *
 * `root` scopes the lookup to one editor instance. It matters when several
 * editors live on the same page rendering clones of the same document (e.g.
 * a CRDT playground): their `data-render-id` values are identical, so a
 * document-wide query always hits the FIRST editor in DOM order — restoring
 * the caret into the wrong instance. Defaults to `document` for backward
 * compatibility (single-editor pages).
 */
export const getRenderDomByID = (
    uuid: string,
    root: ParentNode = document,
) => {
    const allElements = root.querySelectorAll(`[${DATA_RENDER_ID}]`);
    for (const element of allElements) {
        if (element.getAttribute(DATA_RENDER_ID) === uuid) {
            return element as HTMLElement;
        }
    }
    return null;
};