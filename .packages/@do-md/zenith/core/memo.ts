import { BaseStore } from "./BaseStore";

type MemoCacheEntry = {
  value: any;
  deps: any[];
};

// Modified cache structure: use store + propertyName as key
const memoCache = new WeakMap<object, Map<string, MemoCacheEntry>>();

export function createMemo<T extends BaseStore<any>>() {
  return (getDeps: (self: T) => any[]) => memo<T>(getDeps);
}

/**
 * Decorator to memoize getter values based on dependencies.
 *
 * It is recommended to use `createMemo` to create a typed memo decorator for your store,
 * which provides better type inference and cleaner usage.
 *
 * If you prefer to use `memo` directly, remember to provide the store type generic:
 *
 * ```ts
 * class MyStore {
 *   @memo<MyStore>((self) => [self.count])
 *   get double() { return self.count * 2; }
 * }
 * ```
 */
export function memo<T extends BaseStore<any>>(getDeps: (self: T) => any[]) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ): void {
    const originalGetter = descriptor.get;
    if (!originalGetter) throw new Error("@memo can only be used on getters");

    descriptor.get = function () {
      const store = this as T;
      let storeMap = memoCache.get(store);
      if (!storeMap) {
        storeMap = new Map();
        memoCache.set(store, storeMap);
      }

      const deps = getDeps.call(store, store);
      const cacheEntry = storeMap.get(propertyKey);

      if (cacheEntry) {
        const depsChanged =
          deps.length !== cacheEntry.deps.length ||
          deps.some((dep, i) => dep !== cacheEntry.deps[i]);

        if (!depsChanged) return cacheEntry.value;
      }

      const value = originalGetter.call(store);
      storeMap.set(propertyKey, {
        value,
        deps: [...deps],
      });

      return value;
    };
  };
}
