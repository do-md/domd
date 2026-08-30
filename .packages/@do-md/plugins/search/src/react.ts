/**
 * React bindings — the kernel's own posture (`createReactStore(EditorStore)`
 * → EditorStoreProvider / useEditorStoreApi / useEditorStore), applied to
 * SearchStore:
 *
 *   <SearchStoreProvider>          one store instance per provider mount
 *       ...anything that needs the widget or its actions...
 *   </SearchStoreProvider>
 *
 * `useSearchStoreApi()` hands any descendant the instance (a menu item calls
 * `.openFind()` directly — no event bridging), `useSearchStore(s => ...)` is
 * the selector hook (the selector receives the STORE; read `s.state.x`).
 *
 * React enters the dependency graph through zenith (already a react>=18
 * peer), so this module adds no dependency edge — non-React consumers simply
 * never import these names.
 */
import { createReactStore } from "@do-md/zenith";
import { SearchStore } from "./store";

export const {
    StoreProvider: SearchStoreProvider,
    useStoreApi: useSearchStoreApi,
    useStore: useSearchStore,
} = createReactStore(SearchStore);
