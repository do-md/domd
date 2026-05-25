import { useDebugValue, useEffect, useSyncExternalStore } from "react";

import { BaseStore } from "../core/BaseStore";

export function useStoreSelector<S extends BaseStore<any>, TReturn>(
  store: S,
  selector: (store: S) => TReturn,
): TReturn {
  const slice = useSyncExternalStore(
    store.subscribe,
    () => selector(store),
    () => selector(store),
  );
  useDebugValue(slice);
  return slice;
}
