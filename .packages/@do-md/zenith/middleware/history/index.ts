import { enablePatches, Patch } from "immer";
import { BaseStore } from "../../core/BaseStore";

interface History {
    patches: Patch[][];
    inversePatches: Patch[][];
}

interface HistoryOptions {
    maxLength: number;
    debounceTime: number;
}

interface HistoryState {
    list: History[];
    cursor: number;
    last?: History;
    preventPatches: boolean;
    keepRecord: boolean;
}

export function withHistory<T extends object>(store: BaseStore<T>, options: HistoryOptions = {
    maxLength: 30,
    debounceTime: 100
}) {
    enablePatches();
    const originalProduce = store.produce.bind(store);
    const historyState: HistoryState = {
        list: [],
        cursor: 0,
        last: undefined,
        preventPatches: false,
        keepRecord: false,
    };

    const clearLastChange = debounce(() => {
        historyState.last = undefined;
    }, options.debounceTime + 100);

    const updateKeepRecord = (keepRecord: boolean) => {
        historyState.keepRecord = keepRecord;
    }

    const recordHistory = (patches: Patch[], inversePatches: Patch[]) => {
        const { maxLength } = options;
        const state = historyState;

        if (!state.last) {
            while (state.cursor < state.list.length - 1) {
                state.list.pop();
            }
            if (state.list.length > maxLength) {
                state.list.shift();
            }
            state.last = {
                patches: [patches],
                inversePatches: [inversePatches],
            };
            state.list.push(state.last);
            state.cursor = state.list.length - 1;
        } else {
            state.last.patches.push(patches);
            state.last.inversePatches.unshift(inversePatches);
        }

        if (!state.keepRecord) {
            clearLastChange();
        }
    }

    const undo = () => {
        const { debounceTime } = options;
        const state = historyState;

        if (state.cursor < 0) return;
        const history = state.list[state.cursor];

        if (history) {
            history.inversePatches.forEach((inversePatches) => {
                store.applyPatches(inversePatches);
            });
            state.preventPatches = true;
            setTimeout(() => {
                state.preventPatches = false;
            }, debounceTime);
            state.cursor -= 1;
        }
    }

    const redo = () => {
        const { debounceTime } = options;
        const state = historyState;

        const history = state.list[state.cursor + 1];
        if (history) {
            history.patches.forEach((patches) => {
                store.applyPatches(patches);
            });
            state.preventPatches = true;
            setTimeout(() => {
                state.preventPatches = false;
            }, debounceTime);
            state.cursor += 1;
        }
    }

    const produce = (
        fn: (draft: T) => void,
        options?: {
            disableRecord?: boolean;
            patchCallback?: (patches: Patch[], inversePatches: Patch[]) => void;
            actionName?: string;
        }
    ) => {
        originalProduce(fn, {
            actionName: options?.actionName,
            patchCallback: (patches, inversePatches) => {
                const { preventPatches } = historyState;
                if (!preventPatches && !options?.disableRecord) {
                    recordHistory(patches, inversePatches);
                }
                options?.patchCallback?.(patches, inversePatches);
            }
        });
    }

    store.produce = produce;

    return {
        undo,
        redo,
        updateKeepRecord,
    }
}

function debounce<T extends (...args: any[]) => any>(
    fn: T,
    ms: number,
    immediate = false
): (...args: Parameters<T>) => void {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    return function (this: any, ...args: Parameters<T>) {
        const context = this;
        const callNow = immediate && !timer;

        clearTimeout(timer);

        timer = setTimeout(() => {
            timer = undefined;
            if (!immediate) {
                fn.apply(context, args);
            }
        }, ms);

        if (callNow) {
            fn.apply(context, args);
        }
    };
}