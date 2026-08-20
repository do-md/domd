import {
    InlineRuleComponentProps,
    ParentRenderData,
    RenderData,
} from "../../../../../../type";
import Renderer from "../../index";
import { useEditorStore, useEditorStoreApi } from "../../../../../../store";
import styles from "../../../../../../style/DOMD.module.css";
import { memo } from "react";
import { ComponentFallbackBoundary } from "../../base/ComponentFallbackBoundary";
import { getRenderElementProps } from "../../../../../props/getRenderElementProps";
import { getSpanRenderIdProps } from "../../../../../props/getSpanRenderIdProps";
import {
    CompiledRuleRender,
    DATA_INLINE_CAPTURE,
    DATA_INLINE_RULE,
    DATA_INLINE_VARIANT,
    INLINE_RULE_TAG_WHITELIST,
} from "../../../../../../../data-parse/inline-rules";
import { parseInlineRuleParams } from "../../../../../../../data-parse/inline-rule-params";

interface Props {
    parsedData: ParentRenderData | RenderData;
}

/** Raw inner markdown text of the content node (delimiter symbols of NESTED
 *  constructs included — this is the source text between the rule's own
 *  delimiters, exactly what the host wrote). */
const collectContentText = (
    node: ParentRenderData | RenderData,
): string => {
    if (node.children_?.length) {
        return node.children_.map(collectContentText).join("");
    }
    return node.text_ ?? "";
};

/**
 * Content span produced by a declarative inline rule (InlineRuleSpan).
 * Mirrors BaseElement, except the tag comes from `tagName_` (same contract the
 * HTML-block path uses) instead of the static HtmlTags map.
 *
 * The whitelist is re-enforced here on purpose: `tagName_` can arrive over the
 * sync layer from a peer running different rules, so compile-time validation
 * alone doesn't cover it. Anything unknown renders as span.
 *
 * Component channel (v2): when the dispatched rule/variant declares a
 * `component`, it replaces the kernel element — the kernel hands it the same
 * DOM props + children under the InlineRuleComponentProps hard contract
 * (spread domProps on the root, render children verbatim), so the cursor
 * DOM↔model mapping survives host customization. Dispatch is render-time
 * (components aren't serializable): the node carries data-inline-rule /
 * data-inline-variant, looked up against this editor's compiled rule set.
 */
function InlineRuleSpanElement({ parsedData }: Props) {
    const isEditable = useEditorStore((store) => store.isEditable);
    const editorStoreApi = useEditorStoreApi();

    const rawTag = parsedData.tagName_?.toLowerCase();
    const Tag = (
        rawTag && INLINE_RULE_TAG_WHITELIST.has(rawTag) ? rawTag : "span"
    ) as React.ElementType;

    const isContentEditable =
        isEditable && (parsedData.children_?.length ? true : undefined);

    const props = getRenderElementProps(parsedData);
    // Per-tag module styling (e.g. `.InlineRule_mark` keeps the visual parity
    // the old hardcoded Mark type got from `.Mark`).
    const tagStyle = styles[`InlineRule_${rawTag}`];
    if (tagStyle) {
        props.className = [props.className, tagStyle]
            .filter(Boolean)
            .join(" ");
    }

    const children = parsedData.children_?.length
        ? parsedData.children_.map((child) => (
              <Renderer
                  key={
                      child.domVersion_
                          ? `${child.uuid_}@${child.domVersion_}`
                          : child.uuid_
                  }
                  parsedData={child}
              />
          ))
        : parsedData.text_;

    const defaultElement = (
        <Tag
            contentEditable={isContentEditable}
            {...props}
            {...getSpanRenderIdProps(parsedData)}
        >
            {children}
        </Tag>
    );

    // Render-time component dispatch against THIS editor's rule set (a peer
    // without the rule simply renders the default element — declarative
    // degrade, same spirit as the tag whitelist above).
    const ruleOpen = parsedData.htmlProps_?.[DATA_INLINE_RULE];
    if (typeof ruleOpen !== "string") return defaultElement;
    const rule = editorStoreApi.inlineRules_.byOpen_.get(ruleOpen);
    if (!rule) return defaultElement;

    const variantValue = parsedData.htmlProps_?.[DATA_INLINE_VARIANT];
    const variant =
        typeof variantValue === "string" ? variantValue : undefined;
    const render: CompiledRuleRender =
        (variant !== undefined ? rule.variants_?.get(variant) : undefined) ??
        rule.render_;
    const HostComponent = render.component_;
    if (!HostComponent) return defaultElement;

    const captureValue = parsedData.htmlProps_?.[DATA_INLINE_CAPTURE];
    const rawCapture =
        typeof captureValue === "string" ? captureValue : null;
    const params = (rawCapture !== null
        ? parseInlineRuleParams(rawCapture)
        : null) ?? { classes: [], named: {}, positional: [] };

    const componentProps: InlineRuleComponentProps = {
        domProps: {
            contentEditable: isContentEditable,
            ...props,
            ...getSpanRenderIdProps(parsedData),
        },
        children: children,
        variant: variant,
        params: params,
        rawCapture: rawCapture,
        contentText: collectContentText(parsedData),
        tagName: rawTag ?? "span",
    };

    return (
        <ComponentFallbackBoundary slot="inlineRules" fallback={defaultElement}>
            <HostComponent {...componentProps} />
        </ComponentFallbackBoundary>
    );
}

export default memo(InlineRuleSpanElement);
