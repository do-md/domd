import { defineConfig } from "vite";
import { resolve } from "path";

// Same bundling rationale as ../commands/vite.config.ts: the DoMD app consumes this
// package's *source* (tsconfig paths -> src/index.ts), so src/ imports extensionless
// (Turbopack resolves relative specifiers literally), and the published artifact is a
// single dist/index.js with no relative specifiers left inside it.
//
// Externals: zenith (the store base class must be the same module instance the
// consuming app subscribes through). The kernel stays external on principle even
// though this package currently only consumes it structurally.
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
            external: ["@do-md/core-react", "@do-md/zenith"],
        },
    },
});
