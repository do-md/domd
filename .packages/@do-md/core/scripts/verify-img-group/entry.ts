/**
 * Headless assertion matrix for ImgGroup aggregation (the imgGroupSeparators opt-in).
 * Run: sh scripts/verify-img-group/run.sh
 *
 * The contract locked down here:
 *  1. No config → the parse output is unchanged (no ImgGroup nodes) and round-trip holds.
 *  2. "" → only touching images group; images separated by a space do not.
 *  3. " " → one or more spaces group, and the separator text stays verbatim inside the
 *     group.
 *  4. ", " → commas / spaces / a mix of the two group.
 *  5. `\n` in the config has no effect (a soft break never groups); a blank line never
 *     groups across blocks.
 *  6. Edges: a single image is not wrapped, leading/trailing text stays outside the
 *     group, a trailing separator stays outside, a badge (an image nested in a Link)
 *     does not take part, and there is no grouping inside an li (P blocks only).
 *  7. Every shape round-trips byte for byte.
 *  8. After an edit path (chain reparse) the group is still there and round-trip holds.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorStore, DOMDProvider, DOMD } from "../../src";
import { MarkdownType } from "../../src/editor/type/enum";
import { ParentRenderData, RenderData } from "../../src/editor/type";

let passes = 0;
let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
        passes += 1;
    } else {
        failures += 1;
        console.error(`FAIL: ${name}`);
        if (detail !== undefined) console.error("      ", detail);
    }
};

type AnyNode = ParentRenderData | RenderData;
const findGroups = (node: AnyNode, out: AnyNode[] = []): AnyNode[] => {
    if (node.htmlType_ === MarkdownType.ImgGroup) out.push(node);
    for (const child of (node as ParentRenderData).children_ || []) {
        findGroups(child, out);
    }
    return out;
};
const countImgs = (node: AnyNode): number => {
    let n = node.htmlType_ === MarkdownType.Img ? 1 : 0;
    for (const child of (node as ParentRenderData).children_ || []) {
        n += countImgs(child);
    }
    return n;
};
const groupText = (node: AnyNode): string => {
    let text = (node as RenderData).text_ ?? "";
    for (const child of (node as ParentRenderData).children_ || []) {
        text += groupText(child);
    }
    return text;
};

const store = (initMd: string, imgGroupSeparators?: string) =>
    new EditorStore({ initMd, imgGroupSeparators, editable: true });

const A = "![a](1.png)";
const B = "![b](2.png)";
const C = "![c](3.png)";

// ---- 1. opt-in gate: no config = no change at all ----
for (const md of [`${A}${B}`, `${A} ${B}`, `${A}\n${B}`]) {
    const s = store(md);
    check(`off: no groups for ${JSON.stringify(md)}`, findGroups(s.state.renderData_).length === 0);
    check(`off: roundtrip ${JSON.stringify(md)}`, s.toMarkdown() === md, s.toMarkdown());
}

// ---- 2. "" empty separator: only touching images group ----
{
    const s = store(`${A}${B}`, "");
    const groups = findGroups(s.state.renderData_);
    check("empty-sep: adjacent grouped", groups.length === 1 && countImgs(groups[0]) === 2);
    check("empty-sep: group text is exact source", groupText(groups[0]) === `${A}${B}`);
    check("empty-sep: roundtrip", s.toMarkdown() === `${A}${B}`);
}
{
    const s = store(`${A} ${B}`, "");
    check("empty-sep: space-separated NOT grouped", findGroups(s.state.renderData_).length === 0);
    check("empty-sep: space roundtrip", s.toMarkdown() === `${A} ${B}`);
}

// ---- 3. " " space separator: single space / multiple spaces / mixed with touching ----
for (const md of [`${A} ${B}`, `${A}   ${B}`, `${A}${B} ${C}`]) {
    const s = store(md, " ");
    const groups = findGroups(s.state.renderData_);
    check(`space-sep: one group for ${JSON.stringify(md)}`, groups.length === 1, groups.length);
    check(`space-sep: group holds source verbatim ${JSON.stringify(md)}`, groupText(groups[0]) === md, groupText(groups[0]));
    check(`space-sep: roundtrip ${JSON.stringify(md)}`, s.toMarkdown() === md, s.toMarkdown());
}

// ---- 4. ", " comma + space ----
for (const md of [`${A},${B}`, `${A}, ${B}`, `${A} , ${B},${C}`]) {
    const s = store(md, ", ");
    const groups = findGroups(s.state.renderData_);
    check(`comma-sep: grouped ${JSON.stringify(md)}`, groups.length === 1 && countImgs(groups[0]) >= 2);
    check(`comma-sep: roundtrip ${JSON.stringify(md)}`, s.toMarkdown() === md, s.toMarkdown());
}
{
    // An unconfigured comma is ordinary content → no grouping
    const s = store(`${A},${B}`, " ");
    check("space-sep: comma is content, NOT grouped", findGroups(s.state.renderData_).length === 0);
}

// ---- 5. \n never groups: soft break + \n in the config is inert + blank line across blocks ----
{
    const s = store(`${A}\n${B}`, " ");
    check("softbreak: NOT grouped", findGroups(s.state.renderData_).length === 0);
    check("softbreak: roundtrip", s.toMarkdown() === `${A}\n${B}`);
}
{
    const s = store(`${A}\n${B}`, " \n");
    check("softbreak: \\n in config is stripped, still NOT grouped", findGroups(s.state.renderData_).length === 0);
}
{
    const s = store(`${A}\n\n${B}`, " ");
    check("blank line: separate blocks NOT grouped", findGroups(s.state.renderData_).length === 0);
    check("blank line: roundtrip", s.toMarkdown() === `${A}\n\n${B}`);
}

// ---- 6. Edge shapes ----
{
    const s = store(A, " ");
    check("single image: NOT wrapped", findGroups(s.state.renderData_).length === 0);
}
{
    const md = `before ${A} ${B} after`;
    const s = store(md, " ");
    const groups = findGroups(s.state.renderData_);
    check("inline run: grouped inside text", groups.length === 1 && countImgs(groups[0]) === 2);
    check("inline run: group spans first→last img only", groupText(groups[0]) === `${A} ${B}`, groupText(groups[0]));
    check("inline run: roundtrip", s.toMarkdown() === md, s.toMarkdown());
}
{
    const md = `${A} ${B} x ${C}`; // content "x" cuts the run; the lone image after it stays out
    const s = store(md, " ");
    const groups = findGroups(s.state.renderData_);
    check("text breaks run: one group only", groups.length === 1 && countImgs(groups[0]) === 2);
    check("text breaks run: roundtrip", s.toMarkdown() === md, s.toMarkdown());
}
{
    const md = `${A} ${B} ${C} x ${A} ${B}`; // two runs → two groups
    const s = store(md, " ");
    const groups = findGroups(s.state.renderData_);
    check("two runs: two groups", groups.length === 2, groups.length);
    check("two runs: sizes 3+2", countImgs(groups[0]) === 3 && countImgs(groups[1]) === 2);
    check("two runs: roundtrip", s.toMarkdown() === md, s.toMarkdown());
}
{
    const md = `[${A}](https://x.com) ${B} ${C}`; // a badge is a Link, so it stays out
    const s = store(md, " ");
    const groups = findGroups(s.state.renderData_);
    check("badge: excluded from grouping", groups.length === 1 && countImgs(groups[0]) === 2);
    check("badge: roundtrip", s.toMarkdown() === md, s.toMarkdown());
}
{
    const md = `- ${A} ${B}`; // li content parses as paragraph flow → groups too
    const s = store(md, " ");
    check("li: grouped (paragraph-flow uniform)", findGroups(s.state.renderData_).length === 1);
    check("li: roundtrip", s.toMarkdown() === md, s.toMarkdown());
}
{
    const md = `> ${A} ${B}`; // the P inside a blockquote goes through parseP → groups
    const s = store(md, " ");
    check("blockquote paragraph: grouped", findGroups(s.state.renderData_).length === 1);
    check("blockquote: roundtrip", s.toMarkdown() === md, s.toMarkdown());
}

// ---- 7. Edit path: the group survives a chain reparse ----
{
    const md = `${A} ${B}`;
    const s = store(md, " ");
    const placed = s.setSelection({ search: "![a", collapse: "end" });
    check("edit: selection placed", placed.applied === true, placed);
    s.insertText("X");
    const out = s.toMarkdown();
    check("edit: typed into first alt", out === `![aX](1.png) ${B}`, out);
    const groups = findGroups(s.state.renderData_);
    check("edit: group survives reparse", groups.length === 1 && countImgs(groups[0]) === 2, groups.length);
}
{
    // Appending content after the group leaves the group alone
    const md = `${A} ${B} tail`;
    const s = store(md, " ");
    const placed = s.setSelection({ search: "tail" });
    check("edit2: selection placed", placed.applied === true, placed);
    s.insertText("TAIL");
    const groups = findGroups(s.state.renderData_);
    check("edit2: group survives", groups.length === 1 && countImgs(groups[0]) === 2);
    check("edit2: text replaced", s.toMarkdown() === `${A} ${B} TAIL`, s.toMarkdown());
}

// ---- 8. The resetMD seam ----
{
    const s = store("plain text", " ");
    s.resetMD(`${A} ${B}`);
    const groups = findGroups(s.state.renderData_);
    check("resetMD: grouped", groups.length === 1 && countImgs(groups[0]) === 2);
    check("resetMD: roundtrip", s.toMarkdown() === `${A} ${B}`);
}

// ---- 9. Default-render parity (requirement ①: default rendering stays identical) ----
// With grouping on vs. off, the SSR output must be byte-identical once every <span>
// open/close tag is stripped: by default an ImgGroup is nothing but a layout-neutral
// inline span and changes no visible output.
{
    const md = `before ${A} ${B} after`;
    const ssr = (imgGroupSeparators?: string) =>
        renderToStaticMarkup(
            createElement(
                DOMDProvider,
                { initMd: md, editable: false, imgGroupSeparators },
                createElement(DOMD),
            ),
        );
    const off = ssr(undefined);
    const on = ssr(" ");
    const stripSpans = (html: string) =>
        html
            .replace(/<span[^>]*>|<\/span>/g, "")
            // data-render-id is a nanoid, random on every parse → normalize, then compare
            .replace(/data-render-id="[^"]*"/g, 'data-render-id="X"');
    check("ssr: grouped markup has both imgs", (on.match(/<img/g) || []).length === 2);
    check("ssr: default render identical modulo the neutral span", stripSpans(on) === stripSpans(off), { on: stripSpans(on), off: stripSpans(off) });
    check("ssr: off markup has no extra wrapper", off.length < on.length);
}

console.log(`\nverify-img-group: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
