/**
 * React bindings — the kernel's own posture (`createReactStore(EditorStore)`
 * → EditorStoreProvider / useEditorStoreApi / useEditorStore), applied to
 * TocStore:
 *
 *   <TocStoreProvider>             one store instance per provider mount
 *       ...trigger button, outline panel, spy binder...
 *   </TocStoreProvider>
 *
 * `useTocStoreApi()` hands any descendant the instance (attach/detach,
 * setActive), `useTocStore(s => ...)` is the selector hook (the selector
 * receives the STORE; read `s.state.x`).
 *
 * React enters the dependency graph through zenith (already a react>=18
 * peer), so this module adds no dependency edge — non-React consumers simply
 * never import these names.
 */
import { createReactStore } from "@do-md/zenith";
import { TocStore } from "./store";

export const {
    StoreProvider: TocStoreProvider,
    useStoreApi: useTocStoreApi,
    useStore: useTocStore,
} = createReactStore(TocStore);
