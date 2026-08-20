import { useEditorStore } from "../../../store";

/**
 * Reactive formatting state at the current cursor/selection — subscribe a
 * toolbar to `store.formatState` (see FormatState). Re-renders exactly when
 * the cursor or the model moves; the value reference is stable otherwise.
 */
export const useFormatState = () => {
    return useEditorStore((store) => store.formatState);
};
