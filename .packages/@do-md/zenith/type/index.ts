import { BaseStore } from '../core/BaseStore';


export interface StoreOptions {
    enablePatch?: boolean;
}

export enum FetcherState {
    Idle = 'idle',
    Pending = 'pending',
    Success = 'success',
    Error = 'error'
}
export interface APIState<TData = any> {
    state: FetcherState
    data: TData | undefined
    error: any
}

// Extract state type from store
export type ExtractState<S> = S extends BaseStore<infer T> ? T : never;

export const identity = <T>(arg: T): T => arg;