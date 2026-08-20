import { memo } from "react";
import { ParentRenderData } from "../../../../../../type";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { useEditorStoreApi } from "../../../../../../store";

interface Props {
    parsedData: ParentRenderData;
}

function CheckboxesElement({ parsedData }: Props) {
    const props = getRenderElementProps(parsedData);
    const storeApi = useEditorStoreApi();

    return (
        <input
            type="checkbox"
            {...props}
            onClick={(e) => {
                e.preventDefault();
                storeApi.toggleCheckbox_(parsedData.uuid_);
                requestAnimationFrame(() => {
                    // storeApi.editorBlur();
                });
            }}
            onChange={(e) => {
                e.preventDefault();
            }}
        />
    );
}

export default memo(CheckboxesElement);
