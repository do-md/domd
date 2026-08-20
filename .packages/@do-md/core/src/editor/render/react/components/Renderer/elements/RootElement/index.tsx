import { ParentRenderData } from "../../../../../../type";
import styles from "../../../../../../style/DOMD.module.css";
import Renderer from "../../index";
import { useEditorStore } from "../../../../../../store";
import { EditorDomContext } from "../../../../context";
import { MarkdownType } from "../../../../../../type/enum";
import { useContext } from "react";
import { memo } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";

interface Props {
    parsedData: ParentRenderData;
}
function RootElement({ parsedData }: Props) {
    const isEditable = useEditorStore((store) => store.isEditable);
    const domContext = useContext(EditorDomContext);
    const props = getRenderElementProps(parsedData);
    return (
        <div
            {...props}
            data-domd-root=""
            ref={domContext?.textAreaDomRef}
            contentEditable={isEditable}
            spellCheck={false}
            tabIndex={0}
        >
            {parsedData.children_.map((child) => (
                <Renderer key={child.uuid_} parsedData={child} />
            ))}
        </div>
    );
}

export default memo(RootElement);
