/**
 * React bindings — the kernel's own posture (`createReactStore(VirtualStore)`
 * → provider/hooks), plus the one glue component that connects the three
 * parties: the editor store (block summaries + ops), the scroll container
 * (measurement + windows) and the kernel's RenderWindowContext (what
 * RootElement actually renders).
 *
 *   <VirtualStoreProvider>            ...one policy store per editor...
 *     <DOMDProvider store={runtime}>
 *       <VirtualViewport scrollRef={scrollAreaRef} mode="auto">
 *         <DOMD />
 *       </VirtualViewport>
 *     </DOMDProvider>
 *   </VirtualStoreProvider>
 *
 * `mode="off"` (the default) attaches NOTHING — no subscriptions, no
 * observers, a null context value — so the editor renders exactly as it
 * would without this package in the tree.
 */
import { createElement, useEffect, type ReactNode, type RefObject } from "react";
import { createReactStore } from "@do-md/zenith";
import { RenderWindowContext, useEditorStoreApi } from "@do-md/core-react";
import { VirtualStore, type VirtualizationMode } from "./store";
import { bindVirtualViewport } from "./binder";

export const {
    StoreProvider: VirtualStoreProvider,
    useStoreApi: useVirtualStoreApi,
    useStore: useVirtualStore,
} = createReactStore(VirtualStore);

export function VirtualViewport({
    scrollRef,
    mode = "off",
    threshold,
    children,
}: {
    /** The editor's scroll container (the overflow-y element the document
     *  scrolls in). */
    scrollRef: RefObject<HTMLElement | null>;
    /** off = render everything (default); auto = window at/above
     *  `threshold` top-level blocks; always = window unconditionally. */
    mode?: VirtualizationMode;
    /** `auto` activation threshold in top-level blocks. */
    threshold?: number;
    children: ReactNode;
}) {
    const editor = useEditorStoreApi();
    const virtual = useVirtualStoreApi();

    useEffect(() => {
        virtual.configure({ mode, threshold });
    }, [virtual, mode, threshold]);

    useEffect(() => {
        if (mode === "off" || !editor) return;
        return virtual.attach(editor);
    }, [virtual, editor, mode]);

    useEffect(() => {
        if (mode === "off") return;
        const container = scrollRef.current;
        if (!container) return;
        return bindVirtualViewport(virtual, container);
    }, [virtual, scrollRef, mode]);

    const window = useVirtualStore((s) => s.state.window);
    return createElement(
        RenderWindowContext.Provider,
        { value: window },
        children,
    );
}
