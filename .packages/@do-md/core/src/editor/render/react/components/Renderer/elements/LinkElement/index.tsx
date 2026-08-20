import { ParentRenderData, RenderData } from "../../../../../../type";
import Renderer from "../../index";
import { useEditorStore, useEditorStoreApi } from "../../../../../../store";
import { HtmlTags } from "../../../../../../constant";
import { memo } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { getSpanRenderIdProps } from "../../../../../props/getSpanRenderIdProps";

interface Props {
    parsedData: ParentRenderData | RenderData;
}

function LinkElement({ parsedData }: Props) {
    const editorStoreApi = useEditorStoreApi();
    const isEditable = useEditorStore((store) => store.isEditable);

    const Tag = HtmlTags[parsedData.htmlType_];

    const isContentEditable =
        isEditable && (parsedData.children_?.length ? true : undefined);

    const props = getRenderElementProps(parsedData);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>) => {
        if (
            e.metaKey ||
            e.ctrlKey ||
            !editorStoreApi.isEditable
            // || ('ontouchstart' in document && !editor.rootStore.isFocus)
        ) {
            const href = e.currentTarget.getAttribute("data-href");
            if (href) {
                const a = document.createElement("a");
                a.href = href;
                a.target = "_blank";
                a.style.display = "none"; // Hide the element
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a); // Remove the element immediately after click
                // editor.editorBlur();
            }
        }
    };

    return (
        <span>
            <Tag
                contentEditable={isContentEditable}
                {...props}
                {...getSpanRenderIdProps(parsedData)}
                href="#"
                data-href={parsedData.htmlProps_?.href}
                onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
                    e.preventDefault();
                    handleKeyDown(
                        e as unknown as React.KeyboardEvent<HTMLAnchorElement>,
                    );
                }}
            >
                {parsedData.children_?.length
                    ? parsedData.children_.map((child) => (
                        <Renderer key={child.uuid_} parsedData={child} />
                    ))
                    : parsedData.text_}
            </Tag>
        </span>
    );
}

export default memo(LinkElement);
