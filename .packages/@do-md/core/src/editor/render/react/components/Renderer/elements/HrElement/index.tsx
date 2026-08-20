import { ParentRenderData } from "../../../../../../type";
import { HtmlTags } from "../../../../../../constant";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import Renderer from "../../index";
import { useRenderData } from "../../../../hooks/useRenderData";
import { useEditorStore, useEditorStoreApi } from "../../../../../../store";

interface Props {
    parsedData: ParentRenderData;
}
function HrElement({ parsedData }: Props) {
    const Tag = HtmlTags[parsedData.htmlType_];
    const activeAtomicUUID = useEditorStore((s) => s.activeAtomicUUID_);
    const store = useEditorStoreApi();
    const ref = useRef<HTMLDivElement>(null);

    const props = getRenderElementProps(parsedData);

    return (
        <Tag
            ref={ref}
            {...props}
            onClick={(e: MouseEvent) => {
                if (store.isEditable) {
                    e.preventDefault();
                    e.stopPropagation();
                    ref.current?.focus();
                }

            }}
            onFocus={() => {
                if (store.isEditable) {
                    store.setActiveAtomicUUID_(parsedData.uuid_);
                }
            }}
            tabIndex={-1}
            data-active={activeAtomicUUID === parsedData.uuid_}
        >
            <div>
                {parsedData.children_?.length
                    ? parsedData.children_.map((child) => (
                        <Renderer key={child.uuid_} parsedData={child} />
                    ))
                    : parsedData.text_}
            </div>
        </Tag>
    );
}

export default memo(HrElement);
