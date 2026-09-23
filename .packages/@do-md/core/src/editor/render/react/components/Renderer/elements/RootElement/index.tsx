import { ParentRenderData } from "../../../../../../type";
import Renderer from "../../index";
import { useEditorStore } from "../../../../../../store";
import { EditorDomContext, RenderWindowContext } from "../../../../context";
import { useContext, useMemo, useState } from "react";
import { memo } from "react";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { DATA_RENDER_ID } from "../../../../../../../data-parse/constant";
import {
    buildRenderWindowPlan,
    RenderWindowSegment,
} from "../../../../../window/plan";

interface Props {
    parsedData: ParentRenderData;
}

/**
 * uuid of the top-level block hosting `node`, or null when the node does not
 * belong to THIS editor's content (never reached a `data-domd-root`
 * ancestor). Climbing keeps the OUTERMOST `data-render-id` seen, so wrapper
 * elements that carry the id on an inner node (tables) resolve too — the
 * nested uuid is mapped to its top-level index by the plan builder.
 */
const topLevelUuidOf = (node: Node | null): string | null => {
    let el: Element | null =
        node instanceof Element ? node : (node?.parentElement ?? null);
    let uuid: string | null = null;
    while (el) {
        if (el.hasAttribute("data-domd-root")) return uuid;
        const id = el.getAttribute(DATA_RENDER_ID);
        if (id) uuid = id;
        el = el.parentElement;
    }
    return null;
};

/**
 * The LIVE DOM selection endpoints — the store's cursor state is
 * rAF-debounced, so during a drag the DOM can be a frame ahead of it.
 *
 * This is a deliberate impurity inside the plan memo, and it is safe because
 * of what the memo is FOR. The invariant: a block can only be unmounted by a
 * render whose window changed, and a window change changes `renderWindow`'s
 * identity, which invalidates the memo — so every render that could drop a
 * block recomputes the plan against a freshly read selection. A render that
 * does NOT recompute cannot unmount anything, which is exactly when a stale
 * reading would be harmless. Re-running the factory extra times (React may)
 * only repeats an idempotent read. View layer only; never runs while no
 * window is set.
 */
const domSelectionUuids = (): (string | null)[] => {
    if (typeof document === "undefined") return [];
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return [];
    return [
        topLevelUuidOf(selection.anchorNode),
        topLevelUuidOf(selection.focusNode),
    ];
};

function RootElement({ parsedData }: Props) {
    const isEditable = useEditorStore((store) => store.isEditable);
    const domContext = useContext(EditorDomContext);
    const renderWindow = useContext(RenderWindowContext);
    // Model cursor endpoints, subscribed ONLY while a window is set — with no
    // window the selectors return a constant, so the off path never gains a
    // re-render (or any behavior) it did not have before virtualization.
    const cursorStartUuid = useEditorStore((store) =>
        renderWindow ? (store.startCursorInfo?.uuid ?? null) : null,
    );
    const cursorEndUuid = useEditorStore((store) =>
        renderWindow ? (store.endCursorInfo_?.uuid ?? null) : null,
    );
    // uuid → top-level-index hints, validated per use inside the plan builder
    // (a stale hint costs one subtree check and self-heals). Lazily-created
    // STATE, not a ref: the cache is read while rendering, and a ref read
    // during render is both a lint error and a genuine hazard for values that
    // affect output. This one cannot affect output — every entry is verified
    // against the live tree before use and dropped when wrong — so holding it
    // in state (stable identity, never set) keeps the memoization honest.
    const [hintCache] = useState<Map<string, number>>(() => new Map());
    const plan = useMemo<RenderWindowSegment[] | null>(() => {
        if (!renderWindow) return null;
        return buildRenderWindowPlan(
            parsedData,
            renderWindow,
            [cursorStartUuid, cursorEndUuid, ...domSelectionUuids()],
            hintCache,
        );
    }, [parsedData, renderWindow, cursorStartUuid, cursorEndUuid, hintCache]);
    const props = getRenderElementProps(parsedData);
    return (
        <div
            {...props}
            data-domd-root=""
            // Mount through the provider's ref sink so the controller can
            // rebind when the view detaches and re-attaches over a live
            // store; the plain ref object is the legacy fallback for context
            // values that predate the sink.
            ref={domContext?.attachTextAreaDom_ ?? domContext?.textAreaDomRef}
            contentEditable={isEditable}
            spellCheck={false}
            tabIndex={0}
        >
            {plan === null
                ? parsedData.children_.map((child) => (
                      <Renderer key={child.uuid_} parsedData={child} />
                  ))
                : plan.flatMap((segment) =>
                      segment.kind === "spacer" ? (
                          <div
                              key={`domd-virtual-spacer-${segment.key}`}
                              data-domd-virtual-spacer={segment.key}
                              contentEditable={false}
                              aria-hidden
                              style={{
                                  height: segment.height,
                                  userSelect: "none",
                              }}
                          />
                      ) : (
                          parsedData.children_
                              .slice(segment.from, segment.to)
                              .map((child) => (
                                  <Renderer
                                      key={child.uuid_}
                                      parsedData={child}
                                  />
                              ))
                      ),
                  )}
        </div>
    );
}

export default memo(RootElement);
