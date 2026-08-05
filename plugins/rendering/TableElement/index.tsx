"use client";

import {
    RenderChildren,
    RenderData,
    SerializedRenderData,
    getRenderElementProps,
    getSpanRenderIdProps,
    serializeRenderData,
    useEditorStore,
    useEditorStoreApi,
    viewOnlyProps,
} from "@do-md/core-react";
import {
    RefObject,
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useTranslation } from "react-i18next";

interface Props {
    parsedData: RenderData;
}

/**
 * The affordance gutter: 4px gap + 16px strip = 20px = 1.25rem. The wrapper
 * reserves exactly this much on the right (via max-width) and at the bottom
 * (via margin), so the overlay buttons never overlap surrounding content.
 *
 * Each strip lives inside its own invisible HOT ZONE div hugging the table
 * edge (covering the whole gutter, gap included). The "+" is always mounted
 * but transparent; hovering anywhere in that zone — the gap or the strip —
 * reveals only that zone's button. Hovering the table itself reveals nothing.
 */
const ADD_BUTTON_CLASS =
    "tooltip tooltip-bottom absolute flex cursor-pointer select-none " +
    "items-center justify-center rounded-sm border " +
    "opacity-0 transition-opacity duration-150 " +
    "group-hover/zone:opacity-100 " +
    "text-base-content/40 hover:bg-base-content/5 hover:text-base-content/90";

const ADD_BUTTON_BORDER = { borderColor: "var(--domd-table-border)" } as const;

function PlusIcon() {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M6 1.5v9M1.5 6h9"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
            />
        </svg>
    );
}

function DotsIcon({ vertical = false }: { vertical?: boolean }) {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
            style={vertical ? { transform: "rotate(90deg)" } : undefined}
        >
            <circle cx="2.5" cy="6" r="1.1" />
            <circle cx="6" cy="6" r="1.1" />
            <circle cx="9.5" cy="6" r="1.1" />
        </svg>
    );
}

/** Where the caret currently sits inside this table. */
interface CellLocation {
    /** 0-based column index. */
    colIdx: number;
    /** 0-based row index among BODY rows; null = the header row. */
    bodyRowIdx: number | null;
    /** Row index into the flat HTMLTableElement.rows collection. */
    tableRowIdx: number;
}

const subtreeContains = (
    node: SerializedRenderData,
    uuid: string,
): boolean =>
    node.uuid === uuid ||
    !!node.children?.some((child) => subtreeContains(child, uuid));

/**
 * Map a cursor uuid (any node inside a cell: span/paragraph/cell itself) to
 * the (row, column) coordinates of the cell that contains it. Works on the
 * STABLE serialized shape — the internal tree is obfuscated in the published
 * package and must never be walked directly.
 */
function locateCursorCell(
    table: SerializedRenderData,
    cursorUuid: string,
): CellLocation | null {
    let tableRowIdx = 0;
    for (const section of table.children ?? []) {
        const isHead = section.type === "THead";
        const isBody = section.type === "TBody";
        if (!isHead && !isBody) continue;
        let bodyRowIdx = 0;
        for (const row of section.children ?? []) {
            if (row.type !== "TR") continue;
            let colIdx = 0;
            for (const cell of row.children ?? []) {
                if (cell.type !== "TH" && cell.type !== "TD") continue;
                if (subtreeContains(cell, cursorUuid)) {
                    return {
                        colIdx,
                        bodyRowIdx: isBody ? bodyRowIdx : null,
                        tableRowIdx,
                    };
                }
                colIdx++;
            }
            tableRowIdx++;
            if (isBody) bodyRowIdx++;
        }
    }
    return null;
}

const HANDLE_CLASS =
    "absolute flex cursor-pointer select-none items-center justify-center " +
    "rounded-full border bg-base-100 shadow-sm " +
    "text-base-content/50 hover:bg-base-200 hover:text-base-content/90";

const MENU_CLASS =
    "absolute z-10 flex w-max min-w-36 flex-col overflow-hidden rounded-lg " +
    "border bg-base-100 py-1 shadow-lg";

const MENU_ITEM_CLASS =
    "flex cursor-pointer items-center px-3 py-1.5 text-left text-sm " +
    "text-base-content/80 hover:bg-base-200 " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

interface CellHandlesProps {
    tableUuid: string;
    location: CellLocation;
    tableRef: RefObject<HTMLTableElement | null>;
    /** Structure version signal: any table reparse produces a new node, so
     *  passing it as a dep re-measures after row/column mutations. */
    parsedData: RenderData;
}

/**
 * Caret-following editing chrome (Obsidian-style): a horizontal "⋯" handle
 * riding the top edge of the caret's COLUMN and a vertical "⋮" handle riding
 * the left edge of the caret's ROW. Clicking a handle opens a floating menu
 * with insert-after / delete actions for that column/row.
 *
 * Geometry comes from the real cell box (HTMLTableElement.rows[r].cells[c])
 * measured relative to the overlay, re-measured on structure change, table
 * scroll and window resize. Everything here is view-only decoration.
 */
function CellHandles({
    tableUuid,
    location,
    tableRef,
    parsedData,
}: CellHandlesProps) {
    const { t } = useTranslation();
    const storeApi = useEditorStoreApi();
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const [openMenu, setOpenMenu] = useState<"row" | "col" | null>(null);
    const [rects, setRects] = useState<{
        col: { left: number; width: number };
        row: { top: number; height: number };
    } | null>(null);

    const { colIdx, bodyRowIdx, tableRowIdx } = location;

    useLayoutEffect(() => {
        const measure = () => {
            const tableEl = tableRef.current;
            const overlayEl = overlayRef.current;
            const cellEl = tableEl?.rows[tableRowIdx]?.cells[colIdx];
            if (!tableEl || !overlayEl || !cellEl) {
                setRects(null);
                return;
            }
            const base = overlayEl.getBoundingClientRect();
            const cell = cellEl.getBoundingClientRect();
            setRects({
                col: { left: cell.left - base.left, width: cell.width },
                row: { top: cell.top - base.top, height: cell.height },
            });
        };
        measure();
        const scroller = tableRef.current?.parentElement;
        scroller?.addEventListener("scroll", measure);
        window.addEventListener("resize", measure);
        return () => {
            scroller?.removeEventListener("scroll", measure);
            window.removeEventListener("resize", measure);
        };
    }, [tableRef, tableRowIdx, colIdx, parsedData]);

    // The caret moved to another cell (typing, clicking, or a structural op
    // replanting it): stale menus close.
    useEffect(() => setOpenMenu(null), [tableRowIdx, colIdx]);

    // Click-away: any pointerdown outside the overlay closes the menu.
    useEffect(() => {
        if (!openMenu) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!overlayRef.current?.contains(e.target as Node)) {
                setOpenMenu(null);
            }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () =>
            document.removeEventListener("pointerdown", onPointerDown, true);
    }, [openMenu]);

    // Keep every interaction from stealing the caret out of the cell — the
    // handles exist only while the caret is inside; a focus steal would
    // dismiss the very UI being clicked.
    const swallowPointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
        },
        [],
    );

    const insertColumnAfter = useCallback(() => {
        setOpenMenu(null);
        if (storeApi && !storeApi.addTableColumn(tableUuid, colIdx + 1)) {
            console.warn("[TableElement] addTableColumn was a no-op", {
                tableUuid,
                colIdx,
            });
        }
    }, [storeApi, tableUuid, colIdx]);

    const insertRowBelow = useCallback(() => {
        setOpenMenu(null);
        const insertAt = bodyRowIdx === null ? 0 : bodyRowIdx + 1;
        if (storeApi && !storeApi.addTableRow(tableUuid, insertAt)) {
            console.warn("[TableElement] addTableRow was a no-op", {
                tableUuid,
                insertAt,
            });
        }
    }, [storeApi, tableUuid, bodyRowIdx]);

    const deleteColumn = useCallback(() => {
        setOpenMenu(null);
        if (storeApi && !storeApi.deleteTableColumn(tableUuid, colIdx)) {
            console.warn("[TableElement] deleteTableColumn was a no-op", {
                tableUuid,
                colIdx,
            });
        }
    }, [storeApi, tableUuid, colIdx]);

    const deleteRow = useCallback(() => {
        setOpenMenu(null);
        if (bodyRowIdx === null) return; // header row is not deletable
        if (storeApi && !storeApi.deleteTableRow(tableUuid, bodyRowIdx)) {
            console.warn("[TableElement] deleteTableRow was a no-op", {
                tableUuid,
                bodyRowIdx,
            });
        }
    }, [storeApi, tableUuid, bodyRowIdx]);

    if (!rects) {
        // First paint before measurement: mount the overlay so the ref
        // exists, render no chrome yet.
        return (
            <div
                ref={overlayRef}
                {...viewOnlyProps}
                className="pointer-events-none absolute inset-0"
            />
        );
    }

    const colCenter = rects.col.left + rects.col.width / 2;
    const rowCenter = rects.row.top + rects.row.height / 2;

    return (
        <div
            ref={overlayRef}
            {...viewOnlyProps}
            className="pointer-events-none absolute inset-0"
        >
            {/* Column handle: rides the table's top edge, centered on the
                caret's column. */}
            <button
                type="button"
                aria-label={t("editor.table.columnMenu")}
                className={`${HANDLE_CLASS} pointer-events-auto h-3.5 w-6 -translate-x-1/2`}
                style={{ ...ADD_BUTTON_BORDER, left: colCenter, top: -8 }}
                onPointerDown={swallowPointerDown}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenu((m) => (m === "col" ? null : "col"));
                }}
            >
                <DotsIcon />
            </button>
            {/* Row handle: rides the table's left edge, centered on the
                caret's row. */}
            <button
                type="button"
                aria-label={t("editor.table.rowMenu")}
                className={`${HANDLE_CLASS} pointer-events-auto h-6 w-3.5 -translate-y-1/2`}
                style={{ ...ADD_BUTTON_BORDER, left: -8, top: rowCenter }}
                onPointerDown={swallowPointerDown}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenu((m) => (m === "row" ? null : "row"));
                }}
            >
                <DotsIcon vertical />
            </button>
            {openMenu === "col" ? (
                <div
                    className={`${MENU_CLASS} pointer-events-auto -translate-x-1/2`}
                    style={{ ...ADD_BUTTON_BORDER, left: colCenter, top: 10 }}
                    onPointerDown={swallowPointerDown}
                >
                    <button
                        type="button"
                        className={MENU_ITEM_CLASS}
                        onClick={insertColumnAfter}
                    >
                        {t("editor.table.insertColumnRight")}
                    </button>
                    <button
                        type="button"
                        className={MENU_ITEM_CLASS}
                        onClick={deleteColumn}
                    >
                        {t("editor.table.deleteColumn")}
                    </button>
                </div>
            ) : null}
            {openMenu === "row" ? (
                <div
                    className={`${MENU_CLASS} pointer-events-auto -translate-y-1/2`}
                    style={{ ...ADD_BUTTON_BORDER, left: 10, top: rowCenter }}
                    onPointerDown={swallowPointerDown}
                >
                    <button
                        type="button"
                        className={MENU_ITEM_CLASS}
                        onClick={insertRowBelow}
                    >
                        {t("editor.table.insertRowBelow")}
                    </button>
                    <button
                        type="button"
                        className={MENU_ITEM_CLASS}
                        disabled={bodyRowIdx === null}
                        onClick={deleteRow}
                    >
                        {t("editor.table.deleteRow")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Host override for the kernel Table element with Obsidian-style editing
 * chrome, built strictly from the 0.8.0 public override kit (the internal
 * tree is obfuscated in the npm package — structure is read via
 * serializeRenderData, content is rendered via RenderChildren; per-cell
 * self-rendering is not part of the public contract).
 *
 * Editing chrome (all view-only):
 *   - hover hot zones on the right/bottom edges → append column / row
 *   - caret-following ⋯ / ⋮ handles → floating insert/delete menus
 */
function TableElement({ parsedData }: Props) {
    const { t } = useTranslation();
    const isEditable = useEditorStore((store) => store.isEditable);
    const storeApi = useEditorStoreApi();
    const tableRef = useRef<HTMLTableElement | null>(null);

    // Stable-shape snapshot of this table's subtree: cursor-cell lookup works
    // on it (uuids/types are stable keys), recomputed only on reparse.
    const serialized = useMemo(
        () => serializeRenderData(parsedData),
        [parsedData],
    );

    // Caret tracking: subscribe to the cursor NODE only (uuid, not offset)
    // so typing inside one cell never re-renders the table. A caret outside
    // this table resolves to null and renders no chrome.
    const cursorUuid = useEditorStore(
        (store) => store.startCursorInfo?.uuid ?? null,
    );
    const cursorCell = useMemo(
        () => (cursorUuid ? locateCursorCell(serialized, cursorUuid) : null),
        [serialized, cursorUuid],
    );

    const appendColumn = useCallback(() => {
        if (storeApi && !storeApi.addTableColumn(serialized.uuid)) {
            console.warn(
                "[TableElement] addTableColumn was a no-op",
                serialized.uuid,
            );
        }
    }, [storeApi, serialized.uuid]);

    const appendRow = useCallback(() => {
        if (storeApi && !storeApi.addTableRow(serialized.uuid)) {
            console.warn(
                "[TableElement] addTableRow was a no-op",
                serialized.uuid,
            );
        }
    }, [storeApi, serialized.uuid]);

    // Keep the pointerdown from stealing focus/caret out of the editor, and
    // keep the click from bubbling into editor selection handling.
    const swallowPointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
        },
        [],
    );

    return (
        // The wrapper hugs the table width (w-max) so both strips attach to
        // the table's real edges; the kernel .Table vertical margins are
        // moved out here (mt-1/mb-5) and zeroed on the table itself so the
        // strips can span exactly the table box.
        <div className="relative mt-1 mb-5 w-max max-w-[calc(100%-1.25rem)]">
            <div className="TableScrollable">
                <table
                    ref={tableRef}
                    contentEditable={isEditable}
                    {...getRenderElementProps(parsedData)}
                    {...getSpanRenderIdProps(parsedData)}
                    style={{ marginTop: 0, marginBottom: 0 }}
                >
                    <RenderChildren parsedData={parsedData} />
                </table>
            </div>
            {isEditable && cursorCell ? (
                <CellHandles
                    tableUuid={serialized.uuid}
                    location={cursorCell}
                    tableRef={tableRef}
                    parsedData={parsedData}
                />
            ) : null}
            {isEditable ? (
                <>
                    {/* Right hot zone: hugs the table's right edge, spans
                        the gap (4px) + strip (16px). The button sits on the
                        zone's outer side so the gap stays between it and
                        the table, yet hovering the gap still reveals it. */}
                    <div
                        {...viewOnlyProps}
                        className="group/zone absolute top-0 bottom-0 left-full w-5"
                    >
                        <button
                            type="button"
                            data-tip={t("editor.table.addColumn")}
                            className={`${ADD_BUTTON_CLASS} inset-y-0 right-0 w-4`}
                            style={ADD_BUTTON_BORDER}
                            onPointerDown={swallowPointerDown}
                            onClick={(e) => {
                                e.stopPropagation();
                                appendColumn();
                            }}
                        >
                            <PlusIcon />
                        </button>
                    </div>
                    {/* Bottom hot zone: same idea along the bottom edge. */}
                    <div
                        {...viewOnlyProps}
                        className="group/zone absolute top-full left-0 right-0 h-5"
                    >
                        <button
                            type="button"
                            data-tip={t("editor.table.addRow")}
                            className={`${ADD_BUTTON_CLASS} inset-x-0 bottom-0 h-4`}
                            style={ADD_BUTTON_BORDER}
                            onPointerDown={swallowPointerDown}
                            onClick={(e) => {
                                e.stopPropagation();
                                appendRow();
                            }}
                        >
                            <PlusIcon />
                        </button>
                    </div>
                </>
            ) : null}
        </div>
    );
}

export default memo(TableElement);
