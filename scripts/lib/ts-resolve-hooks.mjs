/**
 * ESM resolution hooks that teach Node the app's import style, so
 * `scripts/verify-*` can drive real app modules under
 * `--experimental-strip-types`.
 *
 * App sources are written for a bundler: relative imports carry no extension
 * (`./markdown-line-format`) and `@/…` maps to the project root, per
 * tsconfig's `moduleResolution: "bundler"` and `paths`. Node's ESM resolver
 * accepts neither. Rewriting the app to suit the test runner would be the
 * tail wagging the dog, so the runner adapts instead.
 *
 * Register it with:
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs <script>
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
    // `@/foo/bar` → <project root>/foo/bar
    if (specifier.startsWith("@/")) {
        const base = pathToFileURL(resolvePath(ROOT, specifier.slice(2))).href;
        return tryCandidates(base, context, nextResolve, specifier);
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
