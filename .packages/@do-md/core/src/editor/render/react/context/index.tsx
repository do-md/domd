import { createContext } from "react";
import { EditorDomContextValue, RenderElementProps } from "../../../type";
import { EditorController } from "../../../controller/EditorController";
import { MarkdownType } from "../../../type/enum";

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
