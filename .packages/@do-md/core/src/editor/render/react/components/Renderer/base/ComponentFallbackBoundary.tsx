import { Component, ReactNode } from "react";

/**
 * Host component errors must never take down the editor: the boundary catches
 * render throws and falls back to the kernel's default element rendering.
 * The document text is untouched either way — replacement is view-layer only.
 *
 * Shared by the inlineRules `component` channel and every component slot
 * (components.image/link/codeBlock/table).
 */
export class ComponentFallbackBoundary extends Component<
    { slot: string; fallback: ReactNode; children: ReactNode },
    { failed: boolean }
> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    componentDidCatch(err: unknown) {
        console.warn(
            `[do-md] ${this.props.slot}: component threw during render — falling back to default rendering`,
            err,
        );
    }
    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}
