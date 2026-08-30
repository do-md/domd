"use client";
/**
 * Side-panel trigger machinery + responsive host.
 *
 * Pattern (borrowed from claude-os's nav-drawer, itself built on
 * @do-md/ui-react createDrawer): the open/close state lives in its OWN
 * zenith store behind a provider, so trigger buttons and the rendered panel
 * are fully decoupled — any descendant of SidePanelProvider can drive the
 * panel explicitly (wrap a button in SidePanelTrigger) or imperatively
 * (useSidePanelApi().open/close/toggle, e.g. from a native-titlebar event
 * bridge). Buttons never thread callbacks through component props.
 *
 * DoMD has ONE panel slot with several possible occupants (AI config,
 * versioning), so the state is a discriminator rather than a boolean:
 * toggling an inactive panel replaces the active one — mutual exclusivity
 * is inherent, not wired at every call site.
 *
 * SidePanelHost is the layout half: a DaisyUI drawer wrapping the document.
 * With a panel mounted, `lg:drawer-open` lays it out as an in-flow grid
 * column next to the document (which shrinks to make room); below lg the
 * same markup is the standard overlay drawer. No hard-coded heights — the
 * drawer fills whatever flex row hosts it.
 */
import {
    cloneElement,
    useMemo,
    type MouseEvent,
    type ReactElement,
    type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { createReactStore, ZenithStore } from "@do-md/zenith";

export type SidePanelKind = "ai" | "versioning" | "toc";

interface SidePanelState {
    active: SidePanelKind | null;
}

class SidePanelStore extends ZenithStore<SidePanelState> {
    constructor() {
        super({ active: null });
    }

    public get active(): SidePanelKind | null {
        return this.state.active;
    }

    public openPanel(panel: SidePanelKind) {
        this.produce((draft) => {
            draft.active = panel;
        });
    }

    /** Close the active panel. With `panel`, close only if that one is
     *  active (lets capability teardown — e.g. a dying versioning handle —
     *  dismiss its own panel without knocking out an unrelated one). */
    public closePanel(panel?: SidePanelKind) {
        this.produce((draft) => {
            if (panel === undefined || draft.active === panel) {
                draft.active = null;
            }
        });
    }

    public togglePanel(panel: SidePanelKind) {
        this.produce((draft) => {
            draft.active = draft.active === panel ? null : panel;
        });
    }
}

const { StoreProvider, useStoreApi, useStore } =
    createReactStore(SidePanelStore);

export const SidePanelProvider = StoreProvider;

/** The currently open panel (null = closed). Subscribes the caller. */
export const useSidePanelActive = (): SidePanelKind | null =>
    useStore((s) => s.active);

/** Imperative open/close/toggle for any descendant of the provider. */
export const useSidePanelApi = () => {
    const api = useStoreApi();
    return useMemo(
        () => ({
            open: (panel: SidePanelKind) => api.openPanel(panel),
            close: (panel?: SidePanelKind) => api.closePanel(panel),
            toggle: (panel: SidePanelKind) => api.togglePanel(panel),
        }),
        [api],
    );
};

/** Explicit trigger: attaches a toggle onClick to its child button. */
export function SidePanelTrigger({
    panel,
    children,
}: {
    panel: SidePanelKind;
    children: ReactElement<{ onClick?: (e: MouseEvent) => void }>;
}) {
    const { toggle } = useSidePanelApi();
    return cloneElement(children, {
        onClick: (e: MouseEvent) => {
            children.props.onClick?.(e);
            toggle(panel);
        },
    });
}

/**
 * Responsive host: renders the document (children) and the panel as
 * siblings inside a DaisyUI drawer.
 * - grid-rows-[minmax(0,1fr)] pins the single grid row to the container
 *   height so the document column scrolls internally instead of growing
 *   the row.
 * - lg:h-full overrides .drawer-side's 100dvh (it assumes a full-page
 *   drawer; ours sits under a top bar).
 * - z-50 lifts the overlay drawer above the z-40 top bar.
 * The checkbox mirrors the store (checked = panel mounted); unchecking —
 * the overlay click on small screens — closes via the store api.
 */
export function SidePanelHost({
    id,
    panel,
    side = "right",
    children,
}: {
    /** Unique drawer-toggle id (one per host instance on the page). */
    id: string;
    /** Panel content; null = closed (nothing mounted). */
    panel: ReactNode;
    /** Which edge the panel occupies. Same mechanics either way (in-flow
     *  column on lg, overlay drawer below); DaisyUI's `drawer-end` class is
     *  the only difference. The store holds ONE slot, so left and right can
     *  never be open at once — the side is a property of the ACTIVE panel,
     *  resolved by the app (outline lives left, AI/versioning right). */
    side?: "left" | "right";
    /** The document surface. */
    children: ReactNode;
}) {
    const { t } = useTranslation();
    const { close } = useSidePanelApi();
    const open = panel !== null && panel !== undefined;
    return (
        <div
            className={`drawer ${
                side === "right" ? "drawer-end " : ""
            }flex-1 min-h-0 grid-rows-[minmax(0,1fr)]${
                open ? " lg:drawer-open" : ""
            }`}
        >
            <input
                id={id}
                type="checkbox"
                className="drawer-toggle"
                checked={open}
                onChange={(e) => {
                    if (!e.target.checked) close();
                }}
            />
            <div className="drawer-content flex min-h-0 flex-col">
                {children}
            </div>
            {open ? (
                <div className="drawer-side z-50 lg:h-full">
                    <label
                        htmlFor={id}
                        aria-label={t("common.close")}
                        className="drawer-overlay"
                    />
                    {panel}
                </div>
            ) : null}
        </div>
    );
}
