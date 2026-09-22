/**
 * Golden generator for the off-mode equivalence check.
 *
 * Run this against a PRISTINE kernel dist (before touching the render path)
 * to capture the exact static markup the editor produces today; the harness
 * (run.mts) then re-renders the same fixtures against the CURRENT dist with
 * virtualization off and asserts byte equality — proving the off path is
 * untouched at the rendered-output level.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-virtual-window/golden.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMD, DOMDProvider, EditorStore } from "@do-md/core-react";
import { FIXTURES } from "./fixtures.mts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
mkdirSync(goldenDir, { recursive: true });

/** Render a fixture exactly the way the app mounts the editor (provider +
 *  <DOMD/>), with a bring-your-own store so uuids are deterministic-ish per
 *  run — they are NOT stable across runs, so goldens store markup with uuids
 *  normalized away. */
export const renderFixture = (md: string): string => {
    const store = new EditorStore({ initMd: md, editable: true });
    const markup = renderToStaticMarkup(
        createElement(
            DOMDProvider,
            { store },
            createElement(DOMD),
        ),
    );
    return normalizeUuids(markup);
};

/** uuids (data-render-id / data-span-render-id / react keys leak into no
 *  attributes beyond these) are freshly generated per parse, so byte-level
 *  golden comparison must canonicalize them: every distinct uuid becomes
 *  u<ordinal> in first-appearance order. Structure, order, every other
 *  attribute and all text stay byte-exact. */
export const normalizeUuids = (markup: string): string => {
    const seen = new Map<string, string>();
    return markup.replace(
        /(data-(?:span-|atomic-)?render-id=")([^"]+)(")/g,
        (_m, pre: string, id: string, post: string) => {
            let alias = seen.get(id);
            if (!alias) {
                alias = `u${seen.size}`;
                seen.set(id, alias);
            }
            return `${pre}${alias}${post}`;
        },
    );
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    for (const [name, md] of Object.entries(FIXTURES)) {
        const markup = renderFixture(md);
        writeFileSync(join(goldenDir, `${name}.html`), markup);
        console.log(`golden: ${name} (${markup.length} bytes)`);
    }
}
