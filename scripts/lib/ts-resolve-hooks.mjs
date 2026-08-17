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

export async function resolve(specifier, context, nextResolve) {
    // `@/foo/bar` → <project root>/foo/bar
    if (specifier.startsWith("@/")) {
        const base = pathToFileURL(resolvePath(ROOT, specifier.slice(2))).href;
        return tryCandidates(base, context, nextResolve, specifier);
    }
    // Workspace packages installed as source (`npx i`) live in `.packages/`;
    // the ones consumed as a published build (@do-md/core-react) are in
    // node_modules and must fall through untouched — hence the existence
    // check rather than a blanket rewrite.
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
