import { useEffect } from "react";
import {
    useEditorStore,
} from "../../../store";
import { useEditor } from "./useEditor";

export const UseCursor = () => {
    const cursorInfo = useEditorStore((s) => s.cursorInfo_);
    const editorController = useEditor();
    useEffect(() => { editorController?.replayCursor_(); }, [cursorInfo]);

    return null;
};
