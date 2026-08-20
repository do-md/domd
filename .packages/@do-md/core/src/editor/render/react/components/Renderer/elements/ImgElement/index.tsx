import { memo, useEffect, useState } from "react";
import { ParentRenderData } from "../../../../../../type";
import { HtmlTags } from "../../../../../../constant";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { useEditorStoreApi } from "../../../../../../store";

interface Props {
    parsedData: ParentRenderData;
}

const PLACEHOLDER_SVG =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">' +
            '<rect width="100%" height="100%" fill="#f3f4f6"/>' +
            '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ' +
            'font-family="sans-serif" font-size="14" fill="#9ca3af">Image unavailable</text>' +
            "</svg>",
    );

function ImageElement({ parsedData }: Props) {
    const Tag = HtmlTags[parsedData.htmlType_];
    const { src, ...props } = getRenderElementProps(parsedData);
    const rawSrc = typeof src === "string" ? src : "";
    const editorStore = useEditorStoreApi();
    const loader = editorStore?.imageLoader_;

    const [errored, setErrored] = useState(false);
    const [resolved, setResolved] = useState<string | null>(() =>
        rawSrc && !loader ? rawSrc : null,
    );

    useEffect(() => {
        setErrored(false);
        if (!rawSrc) {
            setErrored(true);
            return;
        }
        if (!loader) {
            setResolved(rawSrc);
            return;
        }

        let cancelled = false;
        let createdBlobUrl: string | null = null;
        setResolved(null);
        loader(rawSrc)
            .then((url) => {
                if (cancelled) {
                    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
                    return;
                }
                if (!url) {
                    setErrored(true);
                    return;
                }
                if (url.startsWith("blob:")) createdBlobUrl = url;
                setResolved(url);
            })
            .catch(() => {
                if (!cancelled) setErrored(true);
            });
        return () => {
            cancelled = true;
            if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
        };
    }, [rawSrc, loader]);

    if (errored || !resolved) {
        return <Tag {...props} src={PLACEHOLDER_SVG} />;
    }
    return (
        <Tag
            contentEditable={false}
            {...props}
            src={resolved}
            onError={() => setErrored(true)}
            onClick={(e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                console.log(222);
                editorStore.handleFocusImage(parsedData.uuid_);
            }}
        />
    );
}

export default memo(ImageElement);
