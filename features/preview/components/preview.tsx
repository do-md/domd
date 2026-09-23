"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    DOMD,
    DOMDProvider,
    useEditorStoreApi,
    useRenderData,
} from "@do-md/core-react";
import "@do-md/core-react/style.css";
import {
    getGrammarVersion,
    subscribeGrammarLoad,
    tokenize,
} from "@/common/lib/prism";
import { appInlineRules } from "@/features/editor/lib/inline-rules";
import { loadImage } from "@/common/lib/image-storage";
import { useLatest } from "@/common/lib/use-latest";
import { useDocLoading } from "@/features/editor/hooks/use-doc-loading";
import { serializeForPersist } from "@/features/editor/lib/persist-gate";

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
    const store = useEditorStoreApi();
    const renderData = useRenderData();
    const renderDataRef = useLatest(renderData);

    const grammarVersion = useSyncExternalStore(
        subscribeGrammarLoad,
        getGrammarVersion,
        () => 0,
    );
    const baseVersionRef = useRef(grammarVersion);
    // A whole-document re-parse is a NEW BASELINE for the kernel: doing it
    // while a large document is still streaming in discards the pending
    // chunked append and freezes the model at the prefix it happens to hold
    // (the mechanism behind the task-54474e data loss). The persistence choke
    // point answers the same question here — "is this a whole document yet?"
    // — and the effect re-runs when the load finishes.
    const docLoading = useDocLoading();
    useEffect(() => {
        if (grammarVersion <= baseVersionRef.current) return;
        if (!store || docLoading) return;
        const id = setTimeout(() => {
            const md = serializeForPersist(store, renderDataRef.current);
            if (md === null) return;
            store.resetMD(md);
        }, 50);
        return () => clearTimeout(id);
    }, [grammarVersion, store, renderDataRef, docLoading]);

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
                    inlineRules={appInlineRules}
                >
                    <GrammarReparseEffect />
                    <DOMD />
                </DOMDProvider>
            </div>
        </div>
    );
}
