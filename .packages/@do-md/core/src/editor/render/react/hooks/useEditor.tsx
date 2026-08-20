import { useContext } from "react";
import { EditorContext } from "../context";

export const useEditor = () => {
    const editor = useContext(EditorContext);
    return editor;
};