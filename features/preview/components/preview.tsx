"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    DOMD,
    DOMDProvider,
    toMarkdown,
    useEditor,
    useRenderData,
} from "@do-md/react";
import "@do-md/react/style.css";
import {
    getGrammarVersion,
    subscribeGrammarLoad,
    tokenize,
} from "@/common/lib/prism";
import { loadImage } from "@/common/lib/image-storage";
import { useLatest } from "@/common/lib/use-latest";

type PreviewWindow = Window & {
    __DOMD_PREVIEW_CONTENT__?: string;
    __DOMD_SET_CONTENT__?: (md: string) => void;
};

function readInitialContent(): string {
    const w = window as PreviewWindow;
    if (typeof w.__DOMD_PREVIEW_CONTENT__ === "string") {
        return w.__DOMD_PREVIEW_CONTENT__;
    }
    if (w.location.hash.length > 1) {
        try {
            return decodeURIComponent(w.location.hash.slice(1));
        } catch {
            return "";
        }
    }
    return "";
}

// Sits inside DOMDProvider so it can resetMD when a grammar loads. Same
// trick as the editor: re-parse so existing code blocks pick up highlighting.
function GrammarReparseEffect() {
    const editor = useEditor();
    const renderData = useRenderData();
    const renderDataRef = useLatest(renderData);

    const grammarVersion = useSyncExternalStore(
        subscribeGrammarLoad,
        getGrammarVersion,
        () => 0,
    );
    const baseVersionRef = useRef(grammarVersion);
    useEffect(() => {
        if (grammarVersion <= baseVersionRef.current) return;
        if (!editor) return;
        const id = setTimeout(() => {
            const md = toMarkdown(renderDataRef.current) ?? "";
            editor.editorStore.resetMD(md);
        }, 50);
        return () => clearTimeout(id);
    }, [grammarVersion, editor, renderDataRef]);

    return null;
}

export function Preview() {
    const [content, setContent] = useState<string | null>(() =>
        typeof window === "undefined" ? null : readInitialContent(),
    );
    const [version, setVersion] = useState(0);

    useEffect(() => {
        const src = new URLSearchParams(window.location.search).get("src");
        if (src) {
            fetch(src)
                .then((r) => r.text())
                .then((md) => {
                    setContent(md);
                    setVersion((v) => v + 1);
                })
                .catch(() => {});
        }

        (window as PreviewWindow).__DOMD_SET_CONTENT__ = (md: string) => {
            setContent(md);
            setVersion((v) => v + 1);
        };

        return () => {
            delete (window as PreviewWindow).__DOMD_SET_CONTENT__;
        };
    }, []);

    if (content === null) {
        return <div className="fixed inset-0 bg-base-100" />;
    }

    return (
        <div className="fixed inset-0 overflow-y-auto bg-base-100">
            <div className="px-6 py-8">
                <DOMDProvider
                    key={version}
                    editable={false}
                    initMd={content}
                    imageLoader={loadImage}
                    codeTokenizer={tokenize}
                >
                    <GrammarReparseEffect />
                    <DOMD />
                </DOMDProvider>
            </div>
        </div>
    );
}
