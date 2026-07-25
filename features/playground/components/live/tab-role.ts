/**
 * Per-tab role negotiation for the live playground, built on the Web Locks
 * API: the tab holding the `primary` lock renders the Alice+Bob pair; every
 * other tab is assigned the lowest free guest slot (one extra collaborator
 * per tab, never two).
 *
 * Web Locks give exactly the lifecycle we need with zero persistence: a
 * held lock dies with its tab, so a guest identity is reclaimed the moment
 * its tab closes, and once every tab is gone the next open becomes the
 * primary (Alice+Bob) again — subsequent tabs then re-assign guests from
 * the first slot.
 */

export type TabRole = { kind: "primary" } | { kind: "guest"; index: number };

const LOCK_PREFIX = "domd-live-playground:role:";
const MAX_GUEST_SLOTS = 24;

/** Try to acquire a lock and hold it for the lifetime of this tab. */
const holdLock = (name: string): Promise<boolean> =>
    new Promise((resolve) => {
        navigator.locks
            .request(name, { ifAvailable: true }, (lock) => {
                if (!lock) {
                    resolve(false);
                    return;
                }
                resolve(true);
                // Hold until the tab closes: the promise never settles and
                // the browser releases the lock when the document dies.
                return new Promise<void>(() => {});
            })
            .catch(() => resolve(false));
    });

let rolePromise: Promise<TabRole> | null = null;

/**
 * Resolve this tab's role exactly once per page load. Module-level
 * singleton: StrictMode remounts reuse the same negotiation, so the locks
 * are never dropped mid-session.
 */
export const negotiateTabRole = (): Promise<TabRole> => {
    if (!rolePromise) {
        rolePromise = (async (): Promise<TabRole> => {
            if (typeof navigator === "undefined" || !navigator.locks) {
                // No Web Locks (old browser): degrade to primary everywhere.
                return { kind: "primary" };
            }
            if (await holdLock(`${LOCK_PREFIX}primary`)) {
                return { kind: "primary" };
            }
            for (let i = 0; i < MAX_GUEST_SLOTS; i += 1) {
                if (await holdLock(`${LOCK_PREFIX}guest-${i}`)) {
                    return { kind: "guest", index: i };
                }
            }
            // Every slot taken (unrealistic for a playground): join without
            // a reserved slot, using an index beyond the pool.
            return {
                kind: "guest",
                index: MAX_GUEST_SLOTS + Math.floor(Math.random() * 1000),
            };
        })();
    }
    return rolePromise;
};
