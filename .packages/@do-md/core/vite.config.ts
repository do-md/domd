import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, readFileSync, writeFileSync } from "fs";
import { brotliCompressSync, constants } from "zlib";

// By default vite's build report only prints gzip sizes, but what modern hosting
// (Vercel/Cloudflare/nginx) actually sends to the browser is brotli. This plugin prints
// the brotli size of every artifact once it is written, so the build log reflects the
// real transfer size.
function reportBrotliSize() {
    return {
        name: "report-brotli-size",
        writeBundle(_options: unknown, bundle: Record<string, any>) {
            const rows = Object.entries(bundle)
                .map(([fileName, chunk]) => {
                    const content =
                        chunk.type === "chunk" ? chunk.code : chunk.source;
                    if (
                        typeof content !== "string" &&
                        !(content instanceof Uint8Array)
                    )
                        return null;
                    const brotli = brotliCompressSync(content, {
                        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
                    }).length;
                    return { fileName, kb: brotli / 1024 };
                })
                .filter(Boolean) as { fileName: string; kb: number }[];
            const pad = Math.max(...rows.map((r) => r.fileName.length));
            for (const { fileName, kb } of rows)
                // eslint-disable-next-line no-console
                console.log(
                    `\x1b[2mdist/\x1b[22m\x1b[36m${fileName.padEnd(pad)}\x1b[39m  \x1b[1mbrotli: ${kb.toFixed(2)} kB\x1b[22m`,
                );
        },
    };
}

// After the build, copy the hand-maintained static assets into dist/ (the published
// package is dist/ and nothing else):
//   - LICENSE / LICENSE-EXCEPTIONS.md: without the copy the published package carries
//     no license at all. The kernel is GPL-3.0 plus two §7 additional permissions, and
//     the two files must always appear together (the additional permissions live in
//     their own file so the GPL body stays the unmodified official text).
//   - README.md: the npm page renders the README from the published package, and we
//     publish from dist/.
//   - dist/package.json: makes dist/ a resolvable package on its own (types/main/module
//     paths relative to dist). The fields are derived from this package's package.json
//     rather than kept as a second template — name / version / description / license /
//     peerDependencies have exactly one source of truth, so relicensing or renaming the
//     package can never miss a second copy.
function copyDistAssets() {
    return {
        name: "copy-dist-assets",
        closeBundle() {
            for (const file of ["LICENSE", "LICENSE-EXCEPTIONS.md", "README.md"])
                copyFileSync(
                    resolve(__dirname, file),
                    resolve(__dirname, "dist", file),
                );

            const pkg = JSON.parse(
                readFileSync(resolve(__dirname, "package.json"), "utf8"),
            );
            const distPkg = {
                name: pkg.name,
                version: pkg.version,
                description: pkg.description,
                license: pkg.license,
                author: pkg.author,
                homepage: pkg.homepage,
                repository: pkg.repository,
                bugs: pkg.bugs,
                keywords: pkg.keywords,
                type: "module",
                types: "./index.d.ts",
                main: "./index.cjs",
                module: "./index.js",
                exports: {
                    ".": {
                        types: "./index.d.ts",
                        import: "./index.js",
                        require: "./index.cjs",
                    },
                    "./style.css": "./style.css",
                },
                peerDependencies: pkg.peerDependencies,
                peerDependenciesMeta: pkg.peerDependenciesMeta,
                publishConfig: { access: "public" },
            };
            writeFileSync(
                resolve(__dirname, "dist/package.json"),
                JSON.stringify(distPkg, null, 4) + "\n",
            );
        },
    };
}

export default defineConfig({
    plugins: [
        react(),
        copyDistAssets(),
        reportBrotliSize(),
    ],
    // Turn off the __publicField helper: core has _xxx class fields of its own
    // (_codeTokenizer, _chunkGeneration and friends). Left on, TS registers those fields
    // through __publicField(this, "_xxx"), whose initialization order does not match
    // useDefineForClassFields semantics.
    esbuild: {
        tsconfigRaw: {
            compilerOptions: {
                useDefineForClassFields: false,
            },
        },
    },
    build: {
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            name: "ReactDomd",
            fileName: "index",
            formats: ["es", "cjs"],
        },
        minify: "terser",
        terserOptions: {
            compress: {
                drop_console: true,
                drop_debugger: true,
                pure_funcs: ["console.log", "console.time", "console.timeEnd"],
                passes: 2,
            },
            // Property mangling (mangle.properties /_$/) is gone. Its only reason to
            // exist was code protection while the kernel was closed source; under
            // GPL-3.0 that protection is pointless, and it carried a real cost:
            // runtime property names changed on every build → no trustworthy type
            // declarations could be generated from the source, leaving a hand-written
            // narrow declaration file as the only option (which has already let the
            // public API and the implementation drift apart once).
            // We now keep compress (where the size win is) and give up mangle
            // properties (for type correctness).
            format: {
                comments: false,
                // Legal notice on the shipped bundles. It goes through terser's
                // preamble rather than rollup's output.banner because terser runs
                // after rollup's banner addon and comments:false would strip it;
                // preamble is emitted verbatim. Without this the published JS would
                // carry no license notice at all.
                preamble:
                    "/*! @do-md/core-react | Copyright (C) 2026 Jayden Wang | " +
                    "GPL-3.0-only with additional permissions under GPL section 7 - " +
                    "see LICENSE and LICENSE-EXCEPTIONS.md | " +
                    "https://github.com/do-md/domd */",
            },
        } as any,
        // es2020 rather than es2015: the source uses ?. / ?? in 212 places, which
        // es2015 expands into verbose if/ternary code while es2020 keeps them as
        // written → ~5% off the gzip size. The peerDep already requires react>=18, so
        // consumer browsers support es2020 anyway (Chrome80+/Safari13.1+/FF74+) and
        // compatibility is unaffected.
        target: "es2020",
        sourcemap: false,
        rollupOptions: {
            external: [
                "react",
                "react-dom",
                "react/jsx-runtime",
                "immer",
                // @do-md/* is no longer external — it is bundled in instead (see
                // resolve.alias below). immer stays external: it is a peerDependency
                // and recognizes drafts through an internal Symbol, so bundling it
                // would create a second instance alongside the consumer's immer and
                // break produce.
            ],
            output: {
                globals: {
                    react: "React",
                    "react-dom": "ReactDOM",
                    "react/jsx-runtime": "jsxRuntime",
                    immer: "immer",
                },
                assetFileNames: "style.css",
                compact: true,
                generatedCode: {
                    constBindings: true,
                },
            },
            treeshake: {
                moduleSideEffects: false,
                // propertyReadSideEffects: false would drop a reflow-triggering
                // property read such as `void el.offsetHeight` as dead code
                // (CustomCursor.resetBlink relies on that line to restart the CSS
                // animation), so leave it at the default true.
            },
        },
        cssCodeSplit: false,
        cssMinify: true,
        reportCompressedSize: true,
    },
    // Bundling @do-md/* in means vite has to resolve them to source. The kernel lives at
    // .packages/core/ in the app repo, a sibling of the .packages/@do-md/* packages it
    // depends on (those two are maintained by the workspace's npx w / npx i, so no second
    // copy is kept here); vite does not read tsconfig paths by default, so these aliases
    // point at exactly the same targets as tsconfig (the more specific /middleware
    // subpath comes before @do-md/zenith so the prefix cannot match first).
    resolve: {
        alias: {
            "@do-md/zenith/middleware": resolve(
                __dirname,
                "../zenith/middleware",
            ),
            "@do-md/zenith": resolve(__dirname, "../zenith"),
            "@do-md/utils": resolve(__dirname, "../utils"),
        },
    },
    css: {
        modules: {
            localsConvention: "camelCase",
            generateScopedName: "DOMD-[local]",
        },
    },
});
