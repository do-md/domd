import { useEditorStore } from "../../../store";

export const useIsEditable = () => {
    return useEditorStore((store) => store.isEditable);
};
