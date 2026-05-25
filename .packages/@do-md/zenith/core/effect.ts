import { BaseStore } from './BaseStore';

interface EffectEntry {
    effect: () => void;
    selectors: ((state: any) => any)[];
    selectorValues: any[];
    unsubscribe: () => void;
}

// Extract state type from store
export type ExtractState<S> = S extends BaseStore<infer T> ? T : never;

// Use WeakMap to store effects for each store
const effectsCache = new WeakMap<BaseStore<any>, Map<number, EffectEntry>>();
let effectIdCounter = 0;

export function addEffect<S extends BaseStore<any>>(
    store: S,
    effect: () => void,
    selectors: ((state: ExtractState<S>) => any)[]
): () => void {
    // Get or create the effects map for this store
    let storeEffects = effectsCache.get(store);
    if (!storeEffects) {
        storeEffects = new Map();
        effectsCache.set(store, storeEffects);
    }

    const effectId = effectIdCounter++;
    const selectorValues = selectors.map((selector) => selector(store.state));

    // Subscribe to store changes
    const unsubscribe = store.subscribe((newState) => {
        const effectData = storeEffects?.get(effectId);
        if (!effectData) return;

        const newDependencyValues = effectData.selectors.map((selector) =>
            selector(newState)
        );

        const hasChanged = newDependencyValues.some(
            (newValue, index) => newValue !== effectData.selectorValues[index]
        );

        if (hasChanged) {
            effectData.effect();
            effectData.selectorValues = newDependencyValues;
        }
    });

    // Store effect entry
    storeEffects.set(effectId, {
        effect,
        selectors,
        selectorValues,
        unsubscribe,
    });

    // Return cleanup function
    return () => {
        const effectData = storeEffects?.get(effectId);
        if (effectData) {
            effectData.unsubscribe();
            storeEffects?.delete(effectId);
        }
    };
}