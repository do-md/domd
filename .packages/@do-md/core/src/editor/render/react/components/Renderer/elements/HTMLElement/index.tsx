import { ParentRenderData } from "../../../../../../type";
import { HtmlTags } from "../../../../../../constant";
import { memo, useContext, useState } from "react";
import styles from "../../../../../../style/DOMD.module.css";
import { EditorContext } from "../../../../context";
import Renderer from "../../index";

interface Props {
    parsedData: ParentRenderData;
}
function HTMLElement({ parsedData }: Props) {
    const Tag = parsedData.tagName_ as React.ElementType;

    // if (isEdit) {
    //     return (
    //         <pre
    //             contentEditable
    //         >
    //             <code
    //                 tabIndex={0}
    //                 contentEditable={true}
    //             >
    //                 {parsedData.text}
    //             </code>
    //         </pre>
    //     )
    // }

    return (
        <Tag
            onClickCapture={(e: React.MouseEvent<HTMLDivElement>) => {
                // e.preventDefault();
                // setIsEdit(true);
            }}
            // className={styles.HTML}
            contentEditable={true}
            suppressContentEditableWarning
            {...(parsedData.htmlProps_ || {})}
            // dangerouslySetInnerHTML={{ __html: parsedData.text }}
            // tabIndex={-1}
        >
            {parsedData.children_?.length
                ? parsedData.children_.map((child) => (
                      <Renderer key={child.uuid_} parsedData={child} />
                  ))
                : parsedData.text_}
        </Tag>
    );
}

export default memo(HTMLElement);
