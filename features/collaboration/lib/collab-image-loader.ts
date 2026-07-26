/**
 * Collaboration-aware image loader for DOMDProvider. Behaves exactly like
 * the plain loadImage until a collaboration session registers a blob
 * fetcher; then a locally-missing `domd-idb://` blob is pulled from online
 * peers before resolving. The loader promise simply stays pending while the
 * bytes travel — the image element renders whenever it settles, no forced
 * re-render needed.
 *
 * Module-level registration (rather than React context) because the
 * imageLoader prop is handed to DOMDProvider before the bridge attaches.
 *
 * Race guard: images can render BEFORE the bridge finishes its async setup
 * (TURN credential fetch precedes transport creation), so a missing blob
 * must WAIT for the fetcher instead of failing permanently. CollabBridge
 * marks the expectation synchronously during render — pages without
 * collaboration never wait and fail fast as before.
 */
import { loadImage } from "@/common/lib/image-storage";

const IDB_PREFIX = "domd-idb://";
const FETCHER_WAIT_MS = 15_000;

/** Returns true when the blob is available locally after the fetch. */
export type CollabBlobFetcher = (id: string) => Promise<boolean>;

let activeFetcher: CollabBlobFetcher | null = null;
let fetcherExpected = false;
const waiters: ((fetcher: CollabBlobFetcher | null) => void)[] = [];

/** Called by CollabBridge during render, ahead of any image render. */
export const markCollabBlobFetcherExpected = (): void => {
    fetcherExpected = true;
};

export const setCollabBlobFetcher = (
    fetcher: CollabBlobFetcher | null,
): void => {
    activeFetcher = fetcher;
    if (fetcher) {
        waiters.splice(0).forEach((waiter) => waiter(fetcher));
    } else {
        fetcherExpected = false; // session over — stop future waits
    }
};

const waitForFetcher = (): Promise<CollabBlobFetcher | null> => {
    if (activeFetcher) return Promise.resolve(activeFetcher);
    if (!fetcherExpected) return Promise.resolve(null);
    return new Promise((resolve) => {
        const waiter = (fetcher: CollabBlobFetcher | null) => {
            clearTimeout(timer);
            resolve(fetcher);
        };
        const timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            resolve(null);
        }, FETCHER_WAIT_MS);
        waiters.push(waiter);
    });
};

export async function collabImageLoader(src: string): Promise<string> {
    try {
        return await loadImage(src);
    } catch (error) {
        if (!src.startsWith(IDB_PREFIX)) throw error;
        console.debug(
            `[collab-img] miss ${src.slice(IDB_PREFIX.length)} ` +
                `expected=${fetcherExpected} hasFetcher=${!!activeFetcher}`,
        );
        const fetcher = await waitForFetcher();
        if (!fetcher) {
            console.debug("[collab-img] no fetcher available, giving up");
            throw error;
        }
        const fetched = await fetcher(src.slice(IDB_PREFIX.length));
        console.debug(`[collab-img] fetch result: ${fetched}`);
        if (!fetched) throw error;
        return loadImage(src);
    }
}
