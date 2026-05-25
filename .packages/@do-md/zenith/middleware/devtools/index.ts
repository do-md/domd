import { BaseStore } from '../../core/BaseStore';
import { Patch } from 'immer';

// Redux DevTools Extension interface
interface ReduxDevtoolsExtension {
    connect(options?: ReduxDevtoolsOptions): ReduxDevtoolsConnection;
}

interface ReduxDevtoolsOptions {
    name?: string;
    instanceId?: string;
    features?: {
        pause?: boolean;
        lock?: boolean;
        persist?: boolean;
        export?: boolean;
        import?: string;
        jump?: boolean;
        skip?: boolean;
        reorder?: boolean;
        dispatch?: boolean;
    };
}

interface ReduxDevtoolsConnection {
    init(state: any): void;
    send(action: string | { type: string; [key: string]: any }, state: any): void;
    subscribe(listener: (message: any) => void): () => void;
}

declare global {
    interface Window {
        __REDUX_DEVTOOLS_EXTENSION__?: ReduxDevtoolsExtension;
    }
}

export interface DevtoolsOptions {
    name?: string;
    enabled?: boolean;
    features?: {
        pause?: boolean;
        lock?: boolean;
        persist?: boolean;
        export?: boolean;
        import?: string;
        jump?: boolean;
        skip?: boolean;
        reorder?: boolean;
        dispatch?: boolean;
    };
}

/**
 * Connect a BaseStore to Redux DevTools Extension
 * 
 * @example
 * ```typescript
 * class MyStore extends BaseStore<State> {
 *     constructor() {
 *         super(initialState);
 *         devtools(this, { name: 'MyStore' });
 *     }
 * 
 *     increment() {
 *         this.produce((draft) => {
 *             draft.count += 1;
 *         }, { actionName: 'INCREMENT' });
 *     }
 * }
 * ```
 */
export function devtools<T extends object>(
    store: BaseStore<T>,
    options: DevtoolsOptions = {}
): () => void {
    if (typeof window === 'undefined') {
        console.warn('DevTools is only available in browser environment');
        return () => {};
    }

    if (options.enabled === false) {
        return () => {};
    }

    const extension = window.__REDUX_DEVTOOLS_EXTENSION__;
    if (!extension) {
        console.warn('Redux DevTools Extension is not installed');
        return () => {};
    }

    const storeName = options.name || store.constructor.name;
    
    const connection = extension.connect({
        name: storeName,
        instanceId: storeName,  // Explicitly set instanceId to ensure proper display
        features: {
            pause: true,
            lock: true,
            persist: true,
            export: true,
            import: 'custom',
            jump: true,
            skip: true,
            reorder: true,
            dispatch: true,
            ...options.features
        }
    });

    // Initialize DevTools with current state
    connection.init(store.state);
    
    // Send initial action to ensure store is properly registered
    connection.send(
        { type: `@@INIT [${storeName}]` },
        store.state
    );

    // Intercept produce method to send updates to DevTools
    const originalProduce = store.produce.bind(store);
    store.produce = function(
        fn: (draft: T) => void,
        options?: {
            disableRecord?: boolean;
            patchCallback?: (patches: Patch[], inversePatches: Patch[]) => void;
            actionName?: string;
        }
    ) {
        originalProduce(fn, options);
        connection.send(options?.actionName || 'STATE_UPDATE', store.state);
    };

    // Subscribe to DevTools messages (time travel, etc.)
    const unsubscribeDevtools = connection.subscribe((message: any) => {
        if (message.type === 'DISPATCH' && message.state) {
            switch (message.payload?.type) {
                case 'JUMP_TO_STATE':
                case 'JUMP_TO_ACTION':
                    // Update store state directly for time travel
                    (store as any)._state = JSON.parse(message.state);
                    // Notify subscribers
                    (store as any)._listeners.forEach((listener: any) => {
                        listener(store.state, store.state);
                    });
                    break;
                case 'RESET':
                    // Reset to initial state
                    (store as any)._state = store.initialState;
                    (store as any)._listeners.forEach((listener: any) => {
                        listener(store.state, store.state);
                    });
                    connection.init(store.state);
                    break;
                case 'COMMIT':
                    connection.init(store.state);
                    break;
            }
        }
    });

    // Return cleanup function
    return () => {
        unsubscribeDevtools();
        // Restore original produce method
        store.produce = originalProduce;
    };
}

