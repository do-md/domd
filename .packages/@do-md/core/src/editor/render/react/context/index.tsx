import { createContext } from "react";
import { EditorDomContextValue, RenderElementProps } from "../../../type";
import { EditorController } from "../../../controller/EditorController";
import { MarkdownType } from "../../../type/enum";
import { RenderWindow } from "../../window/plan";

export const EditorDomContext = createContext<EditorDomContextValue | null>(
    null,
);

export const EditorContext = createContext<EditorController | null>(null);

/** Host components replacing kernel default elements, keyed by MarkdownType.
 *  A replacement has the SAME signature as every kernel element —
 *  `{ parsedData }` — and is dispatched in the Renderer routing layer. */
export const EditorRenderComponentContext = createContext<
    Partial<Record<MarkdownType, React.ComponentType<RenderElementProps>>>
>({});

/** DOM-virtualization seam: a policy layer (e.g. @do-md/virtual) provides a
 *  RenderWindow and RootElement renders only that window of top-level blocks
 *  (plus kernel-forced pins) with spacers standing in for the rest. Null —
 *  the default — renders every block exactly as the non-virtualized editor
 *  always has. */
export const RenderWindowContext = createContext<RenderWindow | null>(null);
