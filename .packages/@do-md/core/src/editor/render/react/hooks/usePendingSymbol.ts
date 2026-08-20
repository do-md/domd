import { useEditorStore } from "../../../store";
export const usePendingSymbol = () => {
    return useEditorStore((store) => store.paddingMdSymbols_);
};
