import { useEditorStore } from "../../../store";

export const useRenderData = () => {
    return useEditorStore((store) => store.renderData_);
};
