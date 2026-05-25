import { ZenithStore } from "@do-md/zenith";

export enum FetcherState {
    Idle = "idle",
    Pending = "pending",
    Success = "success",
    Error = "error",
    Stale = "stale",
}

type MemoCacheEntry = {
    value: unknown;
    deps: unknown[];
};

export interface APIState<TData = unknown> {
    state: FetcherState;
    data: TData | undefined;
    error: unknown;
}

// QueryRef - 查询引用对象，携带类型信息和唯一标识
export interface QueryRef<TData = unknown> extends APIState<TData> {
    readonly __querySymbol: symbol;
    readonly __queryType?: TData; // 仅用于类型推断
}

// Modified cache structure: use store + propertyName as key
const queryCache = new WeakMap<object, Map<string, MemoCacheEntry>>();

// Symbol → Key 映射
const symbolToKeyMap = new WeakMap<object, Map<symbol, string>>();

// Symbol → 当前状态 映射
const symbolToStateMap = new WeakMap<object, Map<symbol, APIState>>();

class QueryStore extends ZenithStore<{ queryState: Record<string, APIState> }> {
    // 存储进行中的 fetch Promise，用于 ensure/refetch 返回
    private _pendingPromises = new Map<string, Promise<unknown>>();

    constructor() {
        super({
            queryState: {},
        });
    }

    public fetcher<TData = unknown>(
        service: () => Promise<TData>,
        key: string,
    ): Promise<TData> | undefined {
        if (!this.state.queryState[key]) {
            this.produce((draft) => {
                draft.queryState[key] = {
                    state: FetcherState.Idle,
                    data: undefined,
                    error: undefined,
                };
            });
        }

        const currentState = this.state.queryState[key];

        // Idle 和 Stale 都可以触发 fetch
        if (
            currentState.state === FetcherState.Idle ||
            currentState.state === FetcherState.Stale
        ) {
            this.produce((draft) => {
                const queryState = draft.queryState[key];
                if (!queryState) {
                    draft.queryState[key] = {
                        state: FetcherState.Pending,
                        data: undefined,
                        error: undefined,
                    };
                } else {
                    // 保留 data（SWR 语义：Stale → Pending 时旧数据仍可展示）
                    queryState.state = FetcherState.Pending;
                    queryState.error = undefined;
                }
            });

            const promise = service()
                .then((res) => {
                    this.produce((draft) => {
                        draft.queryState[key] = {
                            state: FetcherState.Success,
                            data: res,
                            error: undefined,
                        };
                    });
                    this._pendingPromises.delete(key);
                    return res;
                })
                .catch((err) => {
                    this.produce((draft) => {
                        const queryState = draft.queryState[key];
                        if (!queryState) return;
                        queryState.state = FetcherState.Error;
                        queryState.error = err;
                        // data 保留，不清除
                    });
                    this._pendingPromises.delete(key);
                    throw err;
                });

            this._pendingPromises.set(key, promise);
            return promise as Promise<TData>;
        }

        // 已有进行中的请求，返回其 Promise
        return this._pendingPromises.get(key) as Promise<TData> | undefined;
    }

    public getPendingPromise(key: string): Promise<unknown> | undefined {
        return this._pendingPromises.get(key);
    }

    // invalidate 只标记为 Stale，不触发 fetch，不丢失 data
    public invalidate(key: string) {
        this.produce((draft) => {
            const queryState = draft.queryState[key];
            if (!queryState) return;
            // 只有 Success 和 Error 需要标记为 Stale
            if (
                queryState.state === FetcherState.Success ||
                queryState.state === FetcherState.Error
            ) {
                queryState.state = FetcherState.Stale;
            }
            // Pending 状态不做任何事（等当前请求完成）
            // Idle/Stale 状态保持不变
        });
    }

    // retry: Error → 允许重新 fetch（标记为 Stale，由 fetcher 处理 Stale → Pending）
    public retry(key: string) {
        const queryState = this.state.queryState[key];
        if (!queryState || queryState.state !== FetcherState.Error) return;
        this.produce((draft) => {
            draft.queryState[key].state = FetcherState.Stale;
        });
    }

    public mutate<TData = unknown>(
        key: string,
        produceFn: (draft: TData) => TData | void,
    ) {
        if (this.state.queryState[key]?.data === undefined) return;
        this.produce((draft) => {
            const result = produceFn(draft.queryState[key].data as TData);
            if (result !== undefined) {
                draft.queryState[key].data = result as APIState["data"];
            }
        });
    }
}

// 从 QueryRef 中提取数据类型
type InferQueryData<T> = T extends QueryRef<infer TData> ? TData : unknown;

// 单个查询的配置
export interface QueryConfig<TData = unknown> {
    fetcher: () => Promise<TData>;
    enabled?: (self: unknown) => boolean;
    deps?: (self: unknown) => unknown[];
}

// Query Definition Object - 查询定义集合的类型
type QueryDefinitions<T> = {
    [K in keyof T]: QueryConfig<T[K]>;
};

// Query Refs Object - 查询引用集合的类型
type QueryRefs<T> = {
    [K in keyof T]: QueryRef<T[K]>;
};

export function withQuery<T extends object>(store: ZenithStore<T>) {
    const queryStore = new QueryStore();

    // 初始化 Symbol 映射
    let keyMap = symbolToKeyMap.get(store);
    if (!keyMap) {
        keyMap = new Map();
        symbolToKeyMap.set(store, keyMap);
    }

    let stateMap = symbolToStateMap.get(store);
    if (!stateMap) {
        stateMap = new Map();
        symbolToStateMap.set(store, stateMap);
    }

    const idleState: APIState = {
        state: FetcherState.Idle,
        data: undefined,
        error: undefined,
    };

    // queryStore 变化时通知宿主 store 的 subscribers
    // 使用 __queryVersion 使 state 引用实际变化，避免空 produce 的无效通知
    let queryVersion = 0;
    queryStore.subscribe(() => {
        queryVersion++;
        store.produce((draft: any) => {
            draft.__queryVersion = queryVersion;
        });
    });

    // 保存 definitions 的引用，以便在 invalidate 时可以访问
    let definitionsRef: QueryDefinitions<any> | null = null;

    // define - 定义查询集合，返回 Proxy 包装的 QueryRefs
    const define = <TQueries extends Record<string, unknown>>(
        definitions: QueryDefinitions<TQueries>,
    ): QueryRefs<TQueries> => {
        // 保存 definitions 引用
        definitionsRef = definitions;
        // 创建查询引用对象
        const queryRefs: Record<string, QueryRef> = {};

        // 为每个查询创建 Symbol 和映射
        for (const key in definitions) {
            const querySymbol = Symbol(key);
            keyMap!.set(querySymbol, key);

            // 初始化为 idle 状态
            queryRefs[key] = {
                ...idleState,
                __querySymbol: querySymbol,
            } as QueryRef;
        }

        // 使用 Proxy 拦截属性访问，实现懒加载
        return new Proxy(queryRefs, {
            get(target, prop: string) {
                if (typeof prop !== "string" || !(prop in definitions)) {
                    return target[prop];
                }

                const config = definitions[prop];
                const {
                    fetcher,
                    enabled = () => true,
                    deps = () => [],
                } = config;
                const key = prop;
                const querySymbol = target[prop].__querySymbol;

                // 检查是否启用
                if (!enabled.call(store, store)) {
                    return target[prop];
                }

                let cacheMap = queryCache.get(store);
                if (!cacheMap) {
                    cacheMap = new Map();
                    queryCache.set(store, cacheMap);
                }

                const depsValue = deps.call(store, store);
                const cacheEntry = cacheMap.get(key);

                // 检查是否需要重新 fetch
                let shouldFetch = false;

                if (cacheEntry) {
                    const depsChanged =
                        depsValue.length !== cacheEntry.deps.length ||
                        depsValue.some((dep, i) => dep !== cacheEntry.deps[i]);

                    if (depsChanged) {
                        // deps 变化：标记为 Stale（纯标记，不触发 fetch）
                        queryStore.invalidate(key);
                        cacheMap.set(key, {
                            value: cacheEntry.value,
                            deps: depsValue,
                        });
                    }
                }

                // Idle（首次）或 Stale（deps 变化/外部 invalidate）都需要 fetch
                const currentQueryState =
                    queryStore.state.queryState[key]?.state;
                if (
                    !cacheEntry ||
                    currentQueryState === FetcherState.Idle ||
                    currentQueryState === FetcherState.Stale
                ) {
                    shouldFetch = true;
                }

                if (shouldFetch) {
                    queryStore.fetcher(fetcher, key);

                    if (!cacheEntry) {
                        cacheMap.set(key, {
                            value: null,
                            deps: depsValue,
                        });
                    }
                }

                // ✅ 关键修复：直接返回 queryStore 中的状态，保持引用稳定
                const currentState = queryStore.state.queryState[key];

                // 只在状态实际变化时更新 target
                if (
                    target[prop].state !== currentState.state ||
                    target[prop].data !== currentState.data ||
                    target[prop].error !== currentState.error
                ) {
                    target[prop] = {
                        ...currentState,
                        __querySymbol: querySymbol,
                    } as QueryRef;
                }

                return target[prop];
            },
        }) as QueryRefs<TQueries>;
    };

    // 从 QueryRef 中提取 key
    const getKeyFromRef = <TData>(queryRef: QueryRef<TData>): string => {
        const key = keyMap!.get(queryRef.__querySymbol);
        if (!key) {
            throw new Error("Invalid QueryRef: Symbol not found in mapping");
        }
        return key;
    };

    return {
        define,
        // invalidate: 标记为 Stale + 立即触发 refetch（保持向后兼容）
        // 与旧版行为一致，但底层用 Stale 代替 Idle，避免 re-entrancy
        invalidate: <TData>(queryRef: QueryRef<TData>) => {
            const key = getKeyFromRef(queryRef);
            queryStore.invalidate(key);

            if (definitionsRef && key in definitionsRef) {
                const config = definitionsRef[key];
                const { fetcher, enabled = () => true } = config;

                if (enabled.call(store, store)) {
                    queryStore.fetcher(fetcher, key);
                }
            }
        },
        // stale: 只标记为 Stale，不立即 fetch，下次 Proxy 访问时自动 refetch
        stale: <TData>(queryRef: QueryRef<TData>) => {
            const key = getKeyFromRef(queryRef);
            queryStore.invalidate(key);
        },
        // refetch: 标记为 Stale + 立即触发 fetch，返回 Promise（可 await）
        refetch: <TData>(queryRef: QueryRef<TData>): Promise<TData> | undefined => {
            const key = getKeyFromRef(queryRef);
            queryStore.invalidate(key);

            if (definitionsRef && key in definitionsRef) {
                const config = definitionsRef[key];
                const { fetcher, enabled = () => true } = config;

                if (enabled.call(store, store)) {
                    return queryStore.fetcher(fetcher, key);
                }
            }
            return undefined;
        },
        // ensure: 如果已有 Success 数据直接返回，否则触发 fetch 并等待
        ensure: <TData>(queryRef: QueryRef<TData>): Promise<TData> => {
            const key = getKeyFromRef(queryRef);
            const currentState = queryStore.state.queryState[key];

            // 已有成功数据，直接返回
            if (currentState?.state === FetcherState.Success && currentState.data !== undefined) {
                return Promise.resolve(currentState.data as TData);
            }

            // 已有进行中的请求，等待它完成
            const pendingPromise = queryStore.getPendingPromise(key);
            if (pendingPromise) {
                return pendingPromise as Promise<TData>;
            }

            // 触发新的 fetch
            if (definitionsRef && key in definitionsRef) {
                const config = definitionsRef[key];
                const { fetcher } = config;
                const promise = queryStore.fetcher(fetcher, key);
                if (promise) {
                    return promise;
                }
            }

            return Promise.reject(new Error(`Cannot ensure query "${key}": no fetcher defined`));
        },
        // retry: Error 状态下重试（标记为 Stale，下次访问或 refetch 时触发 fetch）
        retry: <TData>(queryRef: QueryRef<TData>) => {
            const key = getKeyFromRef(queryRef);
            queryStore.retry(key);
        },
        mutate: <TData>(
            queryRef: QueryRef<TData>,
            produceFn: (draft: TData) => void,
        ) => {
            const key = getKeyFromRef(queryRef);
            queryStore.mutate<TData>(key, produceFn);
        },
    };
}
