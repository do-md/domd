import { memo } from "react";
import { RenderElementProps } from "../../../../type";
import Renderer from "./index";



/**
 * The kernel-rendered editable content of a node: its children mapped through
 * Renderer with the kernel's key discipline (domVersion-aware remount), or
 * the leaf text. The universal building block for `renderComponent` host
 * overrides — render it exactly ONCE, at the position where the document
 * text lives. Works for any node type; never re-renders the node itself (no
 * dispatch loop).
 */
function RenderChildren({ parsedData }: RenderElementProps) {
    if (parsedData.children_?.length) {
        return (
            <>
                {parsedData.children_.map((child) => (
                    <Renderer
                        key={
                            child.domVersion_
                                ? `${child.uuid_}@${child.domVersion_}`
                                : child.uuid_
                        }
                        parsedData={child}
                    />
                ))}
            </>
        );
    }
    return <>{parsedData.text_}</>;
}

export default memo(RenderChildren);
