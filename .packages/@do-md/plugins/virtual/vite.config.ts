import { defineConfig } from "vite";
import { resolve } from "path";

// Same bundling rationale as ../toc/vite.config.ts: the DoMD app consumes this
// package's *source* (tsconfig paths -> src/index.ts), so src/ imports extensionless
// (Turbopack resolves relative specifiers literally), and the published artifact is a
// single dist/index.js with no relative specifiers left inside it.
//
// Externals: zenith (the store base class must be the same module instance the
// consuming app subscribes through), the kernel (this package provides the kernel's
// own RenderWindowContext — context identity MUST be the app's kernel instance),
// react/react-dom (single React rule).
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
            external: [
                "@do-md/core-react",
                "@do-md/zenith",
                "react",
                "react-dom",
            ],
        },
    },
});
