# @do-md/virtual

DOM virtualization policy for the [@do-md/core-react](https://www.npmjs.com/package/@do-md/core-react) editor: viewport window rendering for very large documents (100k+ top-level blocks), built on the kernel's render-window seam.

The kernel owns the **mechanism** (render only a window of top-level blocks, spacers for the rest, editing invariants force-mounted); this package owns the **policy** (which window: measured/estimated heights, prefix sums, overscan, hysteresis, scroll anchoring) plus the public `scrollToBlock` / `pin` / `materializeForPrint` API other features build on (find-in-page jumps, outline spy, PDF export).

```tsx
import {
    VirtualStoreProvider,
    VirtualViewport,
    useVirtualStoreApi,
} from "@do-md/virtual";

<VirtualStoreProvider>
    <DOMDProvider store={runtime}>
        <VirtualViewport scrollRef={scrollAreaRef} mode="auto">
            <DOMD />
        </VirtualViewport>
    </DOMDProvider>
</VirtualStoreProvider>;
```

Three modes: `off` (default — the package attaches nothing and the editor renders exactly as without it), `auto` (virtualize at/above `threshold` top-level blocks, default 500), `always`.

Requires a kernel release that ships the render-window seam (`RenderWindowContext`, `getTopLevelBlocks`); on the `peerDependencies` floor without the seam this package still compiles but `VirtualViewport` has nothing to feed.

## Known v1 boundaries

- Only **top-level blocks** are virtualized; a single giant block (a 50k-line code fence) is mounted whole.
- Remote (collaborative) structural edits that keep the top-level block count unchanged can leave window pads stale until the next local structural op or scroll — editing correctness is unaffected (kernel invariants).
- Presence cursors of peers in unmounted blocks are not painted (no error, simply absent) — edge indicators are a follow-up.
