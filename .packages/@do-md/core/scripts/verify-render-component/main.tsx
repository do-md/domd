/**
 * Headless assertion matrix for the renderComponent override mechanism
 * (replace kernel default elements with host components — the plugin surface).
 *
 * Run: npx esbuild scripts/verify-render-component/main.tsx --bundle \
 *        --format=esm --platform=node --jsx=automatic \
 *        --outfile=scripts/verify-render-component/out.mjs \
 *      && node scripts/verify-render-component/out.mjs
 *
 * Strategy: renderToStaticMarkup through the REAL integration path
 * (DOMDProvider → renderComponent context → Renderer dispatch). Host
 * components are written EXACTLY the way the public docs prescribe: single
 * `{ parsedData }` prop + the public kit (RenderChildren,
 * getRenderElementProps/getSpanRenderIdProps, serializeRenderData,
 * toMarkdown). `editable=false` keeps UseCursor/UseEditorEvent out of the
 * tree (SSR-safe).
 *
 * NOT covered here (React limitation, not a design gap): the
 * ComponentFallbackBoundary throw→default fallback — class error boundaries
 * do not run during server rendering. The boundary is the same code that
 * shipped field-proven in the inlineRules component channel.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
    DOMD,
    DOMDProvider,
    MarkdownType,
    RenderChildren,
    Renderer,
    getRenderElementProps,
    getSpanRenderIdProps,
    serializeRenderData,
    toMarkdown,
} from "../../src";
import type { ParentRenderData, RenderData } from "../../src";

type Node = ParentRenderData | RenderData;

let failures = 0;
let passes = 0;

const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
        passes += 1;
    } else {
        failures += 1;
        console.error(
            `✗ ${name}`,
            detail !== undefined ? JSON.stringify(detail) : "",
        );
    }
};

const MD = [
    "hello ![pic](http://x/img.png) world",
    "",
    "a [label](http://link.example) b",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "| h1 | h2 |",
    "| --- | --- |",
    "| c1 | c2 |",
].join("\n");

type RenderComponentMap = Partial<
    Record<MarkdownType, React.ComponentType<{ parsedData: Node }>>
>;

const render = (renderComponent?: RenderComponentMap) =>
    renderToStaticMarkup(
        <DOMDProvider
            editable={false}
            initMd={MD}
            renderComponent={renderComponent as any}
        >
            <DOMD />
        </DOMDProvider>,
    );

// ---------------------------------------------------------------------------
// 0. Baseline — no overrides: default elements render untouched
// ---------------------------------------------------------------------------
const baseline = render();
{
    check("baseline: default img renders", baseline.includes("<img"));
    check(
        "baseline: img src passthrough (no loader)",
        baseline.includes('src="http://x/img.png"'),
    );
    check("baseline: default link renders as <a>", baseline.includes("<a"));
    check(
        "baseline: link neutralized href + data-href",
        baseline.includes('href="#"') &&
            baseline.includes('data-href="http://link.example"'),
    );
    check("baseline: default code shell", baseline.includes("<pre"));
    check(
        "baseline: code topbar chrome present",
        baseline.includes('data-language="js"'),
    );
    check("baseline: default table renders", baseline.includes("<table"));
    check(
        "baseline: table cells present",
        baseline.includes("h1") && baseline.includes("c2"),
    );
}

// ---------------------------------------------------------------------------
// 1. inlineRules regression — boundary extraction didn't disturb the channel
// ---------------------------------------------------------------------------
{
    const html = renderToStaticMarkup(
        <DOMDProvider editable={false} initMd={"x ==hi== y"}>
            <DOMD />
        </DOMDProvider>,
    );
    check(
        "inlineRules: default == still renders <mark>",
        html.includes("<mark"),
    );
    check("inlineRules: content intact", html.includes("hi"));
}

// ---------------------------------------------------------------------------
// 2. Host components — the documented recipe: one prop + the public kit
// ---------------------------------------------------------------------------
const HostImage = ({ parsedData }: { parsedData: Node }) => {
    // Node data via stable keys — the sanctioned way across obfuscation.
    const { src } = serializeRenderData(parsedData).props as { src?: string };
    return (
        <span
            {...getRenderElementProps(parsedData)}
            contentEditable={false}
            data-test="img-host"
            data-src={src ?? ""}
        />
    );
};

const HostLink = ({ parsedData }: { parsedData: Node }) => {
    const { href } = serializeRenderData(parsedData).props as { href?: string };
    return (
        <a
            {...getRenderElementProps(parsedData)}
            {...getSpanRenderIdProps(parsedData)}
            data-test="link-host"
            data-href={href ?? ""}
        >
            <RenderChildren parsedData={parsedData} />
        </a>
    );
};

const HostCode = ({ parsedData }: { parsedData: Node }) => {
    // Fence line via stable keys (children[0].text = "```js").
    const fence = serializeRenderData(parsedData).children?.[0]?.text ?? "";
    return (
        <pre
            {...getRenderElementProps(parsedData)}
            contentEditable={false}
            data-test="code-host"
            data-lang={fence.slice(3) || "plain"}
            data-md-len={String((toMarkdown(parsedData as any) || "").length)}
        >
            <RenderChildren parsedData={parsedData} />
        </pre>
    );
};

const HostTable = ({ parsedData }: { parsedData: Node }) => (
    <div data-test="table-host">
        <table {...getRenderElementProps(parsedData)}>
            <RenderChildren parsedData={parsedData} />
        </table>
    </div>
);

const overrides: RenderComponentMap = {
    [MarkdownType.Img]: HostImage,
    [MarkdownType.Link]: HostLink,
    [MarkdownType.Pre]: HostCode,
    [MarkdownType.Table]: HostTable,
};

{
    const html = render(overrides);

    // image
    check("image: host dispatched", html.includes('data-test="img-host"'));
    check(
        "image: src readable via serializeRenderData props",
        html.includes('data-src="http://x/img.png"'),
    );
    check("image: default <img> replaced", !html.includes("<img"));
    check(
        "image: hidden md-symbol source text still in DOM (round-trip)",
        html.includes("![pic](http://x/img.png)"),
    );

    // link
    check("link: host dispatched", html.includes('data-test="link-host"'));
    check(
        "link: href readable via serializeRenderData props",
        html.includes('data-href="http://link.example"'),
    );
    check(
        "link: RenderChildren renders editable label verbatim",
        html.includes("label"),
    );

    // codeBlock
    check("code: host dispatched", html.includes('data-test="code-host"'));
    check(
        "code: language derivable from stable-key fence text",
        html.includes('data-lang="js"'),
    );
    check(
        "code: RenderChildren renders code line blocks",
        html.includes("const a = 1;"),
    );
    check(
        "code: toMarkdown reads node source",
        /data-md-len="([1-9][0-9]*)"/.test(html),
    );
    check(
        "code: default topbar chrome replaced",
        !html.includes('data-language="js"'),
    );

    // table
    check("table: host dispatched", html.includes('data-test="table-host"'));
    check(
        "table: host <table> + RenderChildren rows/cells",
        html.includes("<table") &&
            html.includes("c2") &&
            html.includes("<td"),
    );
}

// ---------------------------------------------------------------------------
// 3. Partial map — untouched defaults keep rendering
// ---------------------------------------------------------------------------
{
    const html = render({ [MarkdownType.Img]: HostImage });
    check("partial: image host active", html.includes('data-test="img-host"'));
    check(
        "partial: link default untouched",
        html.includes('data-href="http://link.example"'),
    );
    check(
        "partial: code default untouched",
        html.includes('data-language="js"'),
    );
    check("partial: table default untouched", html.includes("<table"));
}

// ---------------------------------------------------------------------------
// 4. Renderer re-export sanity — hosts can hand nodes back to the kernel
// ---------------------------------------------------------------------------
{
    check("Renderer is exported for plugins", typeof Renderer !== "undefined");
    check(
        "RenderChildren is exported for plugins",
        typeof RenderChildren !== "undefined",
    );
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
