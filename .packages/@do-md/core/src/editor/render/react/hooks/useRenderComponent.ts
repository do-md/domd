import { useContext } from "react";
import { EditorRenderComponentContext } from "../context";

export const useRenderComponent = () => {
    return useContext(EditorRenderComponentContext);
}
