import { RenderElementProps } from "../../../../type";
import { NonRenderedElements } from "../../../../constant";
import { memo } from "react";
import { useRenderComponent } from "../../hooks/useRenderComponent";
import { getRenderComponent } from "./getRenderComponent";
import { ComponentFallbackBoundary } from "./base/ComponentFallbackBoundary";

function Renderer({ parsedData }: RenderElementProps) {
    const renderComponent = useRenderComponent();
    if (NonRenderedElements.has(parsedData.htmlType_)) return null;

    const DefaultComponent = getRenderComponent(parsedData.htmlType_);
    const HostComponent = renderComponent[parsedData.htmlType_];
    if (!HostComponent) return <DefaultComponent parsedData={parsedData} />;

    // Host override: same single-prop signature as every kernel element.
    // A host render throw falls back to the default element — the document
    // text is untouched either way (overrides are view-layer only).
    return (
        <ComponentFallbackBoundary
            slot={`renderComponent.${parsedData.htmlType_}`}
            fallback={<DefaultComponent parsedData={parsedData} />}
        >
            <HostComponent parsedData={parsedData} />
        </ComponentFallbackBoundary>
    );
}

export default memo(Renderer);
