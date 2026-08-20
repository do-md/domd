import { ParentRenderData, RenderData } from "../../../../../../type";
import styles from "../../../../../../style/DOMD.module.css";
import { HtmlTags } from "../../../../../../constant";
import { memo, useMemo } from "react";
import { useIsEditable } from "../../../../hooks/useIsEditable";
import { useEditorStore } from "../../../../../../store";
import { usePendingSymbol } from "../../../../hooks/usePendingSymbol";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";

interface Props {
    parsedData: ParentRenderData | RenderData;
}

function MdSymbolElement({ parsedData }: Props) {
    const isEditable = useIsEditable();
    const mode = useEditorStore((store) => store.mode);
    const paddingMdSymbols = usePendingSymbol();

    // "rich" mode: syntax symbols are NEVER revealed (no caret-adjacent
    // reveal). The symbol text stays in the DOM (display:none), so model
    // text == DOM text and every offset/round-trip path is untouched.
    const isActive = useMemo(() => {
        if (mode === "rich") return false;
        if (!paddingMdSymbols) return false;
        return parsedData.mdSymbols_.every((symbol) =>
            paddingMdSymbols.find((s) => s === symbol),
        );
    }, [mode, paddingMdSymbols, parsedData.mdSymbols_]);

    const Tag = HtmlTags[parsedData.htmlType_];

    const isContentEditable =
        isEditable && (parsedData.children_?.length ? true : undefined);

    const props = getRenderElementProps(parsedData);

    return (
        <Tag
            contentEditable={isContentEditable}
            {...props}
            data-active={isActive}
        >
            {parsedData.text_}
        </Tag>
    );
}

export default memo(MdSymbolElement);
