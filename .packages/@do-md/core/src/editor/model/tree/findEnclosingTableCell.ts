import { MarkdownType } from "../../type/enum";
import { AnyNode, ParentRenderData } from "../../type";

/**
 * The table cell (TH/TD) that encloses `uuid` within `scope`, plus that
 * cell's position in `scope`'s document-order cell sequence.
 *
 * A selection edit needs this because a table is ONE top-level block whose
 * cells are nested render blocks. Both endpoints of a cross-cell selection
 * therefore resolve to the same top-level index, and the edit path serializes
 * the whole table and replaces everything between the two cursor markers —
 * which in markdown includes the ` | ` that separates the cells. Deleting that
 * merges two cells into one and leaves a row shorter than its neighbours.
 *
 * Returns null when `uuid` is not inside a cell, which is every non-table
 * selection and also a selection spanning whole rows of the table itself.
 */
export const findEnclosingTableCell = (
    uuid: string,
    scope: AnyNode,
): { cell: ParentRenderData; order: number } | null => {
    let counter = 0;
    let found: { cell: ParentRenderData; order: number } | null = null;

    const walk = (
        node: AnyNode,
        cell: ParentRenderData | null,
        order: number,
    ) => {
        if (found) return;
        let nextCell = cell;
        let nextOrder = order;
        if (
            node.htmlType_ === MarkdownType.TH ||
            node.htmlType_ === MarkdownType.TD
        ) {
            nextCell = node as ParentRenderData;
            nextOrder = counter++;
        }
        if (node.uuid_ === uuid && nextCell) {
            found = { cell: nextCell, order: nextOrder };
            return;
        }
        const children = (node as ParentRenderData).children_;
        if (!children) return;
        for (const child of children) walk(child, nextCell, nextOrder);
    };

    walk(scope, null, -1);
    return found;
};
