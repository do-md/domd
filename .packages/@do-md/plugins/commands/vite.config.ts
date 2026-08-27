import { defineConfig } from "vite";
import { resolve } from "path";

// Why a bundler for a package that is nothing but pure functions.
//
// The DoMD app consumes this package's *source* (tsconfig paths -> src/index.ts), so a
// plugin edit is live in the app with no publish step in between. That rules out
// NodeNext-style ".js"-suffixed relative specifiers in src/, because Turbopack resolves
// relative imports literally and will not substitute target.ts for "./target.js"
// (experimental.extensionAlias, the webpack fix for exactly this, is unsupported under
// Turbopack). So src/ imports extensionless — and once it does, the published artifact
// must not contain relative specifiers at all, since Node's ESM loader cannot resolve
// extensionless ones either. A rollup bundle satisfies both: one dist/index.js, no
// relative imports left inside it.
//
// The kernel is external. Today every reference to it is `import type`, so it does not
// survive compilation anyway; listing it makes a future value import fail loudly here
// instead of quietly inlining a second copy of the kernel into a plugin bundle.
export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            fileName: "index",
            formats: ["es"],
        },
        // Unminified on purpose: this is a library. The consuming app minifies, and a
        // readable dist keeps stack traces from released plugins worth reading.
        minify: false,
        sourcemap: true,
        target: "es2020",
        rollupOptions: {
            external: ["@do-md/core-react"],
        },
    },
});
