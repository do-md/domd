/**
 * ESM resolution hooks that teach Node the app's import style, so
 * `scripts/verify-*` can drive real app modules under
 * `--experimental-strip-types`.
 *
 * App sources are written for a bundler: relative imports carry no extension
 * (`./line-format`), `@/…` maps to the project root, and workspace packages
 * are TypeScript source copied into `.packages/` rather than built output in
 * `node_modules`, per tsconfig's `moduleResolution: "bundler"` and `paths`.
 * Node's ESM resolver accepts none of it. Rewriting the app to suit the test
 * runner would be the tail wagging the dog, so the runner adapts instead.
 *
 * Register it with:
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs <script>
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

// The editor kernel lives in this repository as TypeScript source at
// `.packages/@do-md/core/src`, which is what tsconfig `paths` and the bundler
// resolve to. Node cannot be pointed at that source: `--experimental-strip-types`
// removes type annotations but does not transform JSX, and the kernel's render
// layer is `.tsx`. So the harnesses import the kernel's build output instead,
// which means the kernel has to be built before they run.
const KERNEL_PACKAGE = "@do-md/core-react";
const KERNEL_DIST = ".packages/@do-md/core/dist";

export async function resolve(specifier, context, nextResolve) {
    // `@/foo/bar` → <project root>/foo/bar
    if (specifier.startsWith("@/")) {
        const base = pathToFileURL(resolvePath(ROOT, specifier.slice(2))).href;
        return tryCandidates(base, context, nextResolve, specifier);
    }
    // The kernel: package name (`@do-md/core-react`) and directory name (`core`)
    // differ, so the generic rule below cannot find it either way.
    if (
        specifier === KERNEL_PACKAGE ||
        specifier.startsWith(`${KERNEL_PACKAGE}/`)
    ) {
        const subpath = specifier.slice(KERNEL_PACKAGE.length + 1);
        const target = resolvePath(ROOT, KERNEL_DIST, subpath || "index.js");
        if (!existsSync(target)) {
            throw new Error(
                `Cannot resolve "${specifier}": ${target} does not exist. ` +
                    "The kernel has to be built before the verify harnesses run — " +
                    "(cd .packages/@do-md/core && npm run build)",
            );
        }
        return nextResolve(pathToFileURL(target).href, context);
    }
    // Other workspace packages are copied into `.packages/` as source under
    // their own name; anything not found there falls through untouched — hence
    // the existence check rather than a blanket rewrite.
    if (specifier.startsWith("@do-md/")) {
        const dir = resolvePath(ROOT, ".packages", specifier);
        if (existsSync(dir)) {
            return tryCandidates(
                pathToFileURL(dir).href,
                context,
                nextResolve,
                specifier,
            );
        }
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return tryCandidates(specifier, context, nextResolve, specifier);
    }
    return nextResolve(specifier, context);
}

async function tryCandidates(base, context, nextResolve, original) {
    for (const suffix of ["", ...CANDIDATE_SUFFIXES]) {
        try {
            return await nextResolve(base + suffix, context);
        } catch {
            // Try the next shape.
        }
    }
    return nextResolve(original, context);
}
