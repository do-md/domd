import { memo, useCallback, useRef, useState } from "react";
import styles from "../../../../../../style/DOMD.module.css";
import { ParentRenderData } from "../../../../../../type";
import Renderer from "../../index";
import { toMarkdown } from "../../../../../../model/serialize/toMarkdown";
import { CopiedIcon } from "./CopiedIcon";
import { CopyIcon } from "./CopyIcon";
import { copyTextToClipboard } from "@do-md/utils";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { useEditorStore } from "../../../../../../store";

interface Props {
    parsedData: ParentRenderData;
}

interface TopBarProps {
    language: string;
    onCopy: () => void;
}

const PreCodeTopBar = memo(function PreCodeTopBar({
    language,
    onCopy,
}: TopBarProps) {
    const [copied, setCopied] = useState(false);

    const handleClick = () => {
        onCopy();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className={styles.PreCodeTopBar} contentEditable={false}>
            <div className={styles.PreCodeLanguage} data-language={language} />
            {copied ? (
                <div className={styles.PreCodeCopy}>
                    <CopiedIcon />
                    <div className={styles.PreCodeCopiedLabel}></div>
                </div>
            ) : (
                <div className={styles.PreCodeCopy} onClick={handleClick}>
                    <CopyIcon />
                    <div className={styles.PreCodeCopyLabel}></div>
                </div>
            )}
        </div>
    );
});

function CodeAreaElement({ parsedData }: Props) {
    const props = getRenderElementProps(parsedData);
     const isEditable = useEditorStore((store) => store.isEditable);
    
    const parsedDataRef = useRef(parsedData);
    parsedDataRef.current = parsedData;

    const handleCopy = useCallback(() => {
        const text = toMarkdown(parsedDataRef.current.children_[2]);
        copyTextToClipboard(text);
    }, []);

    const language = parsedData.children_[0].text_?.slice(3) || "plain";

    return (
        <pre
            {...props}
            contentEditable={isEditable}
            onTouchEnd={(e) => {
                e.stopPropagation();
            }}
        >
            <PreCodeTopBar language={language} onCopy={handleCopy} />
            <div className={styles.PreCodeContent}>
                {parsedData.children_?.length
                    ? parsedData.children_.map((child) => (
                          <Renderer key={child.uuid_} parsedData={child} />
                      ))
                    : parsedData.text_}
            </div>
        </pre>
    );
}

export default memo(CodeAreaElement);
