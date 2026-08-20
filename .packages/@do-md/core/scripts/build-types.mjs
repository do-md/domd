// Generates the type declarations we publish: dist/index.d.ts (single file, self-contained).
//
// Before the kernel went open source this was a hand-maintained types/index.d.ts — the
// build mangled every internal `_`-suffixed property into a random name, so generated
// declarations could never match the runtime and the only workable option was to curate a
// narrow "stable public surface" by hand. Property mangling was removed along with the
// open-sourcing (see terserOptions in vite.config.ts), so declarations and runtime agree
// again and this switched to generating all of them: the type surface can no longer drift
// away from the implementation.
//
// Two steps:
//   1. tsc --emitDeclarationOnly → .types-tmp/: the kernel declarations land in
//      .types-tmp/core/src/, and the two internal dependencies (@do-md/utils and
//      @do-md/zenith — sibling directories outside this package that are bundled in) land
//      in .types-tmp/utils and .types-tmp/zenith. tsc does not rewrite module specifiers,
//      so the tree still refers to the bare "@do-md/xxx".
//   2. api-extractor collapses the whole tree into a single file. It runs with
//      scripts/tsconfig.types.json, whose paths point "@do-md/xxx" at the declarations in
//      .types-tmp — so the internal dependencies' types are inlined too, and consumers who
//      cannot install those two packages are unaffected.
//
// Why not vite-plugin-dts's rollupTypes: it infers the declaration entry and the relative
// paths from "the common parent directory of all source files to be emitted", and because
// the two internal dependencies live outside the package that parent is pushed up a level
// — the entry path no longer matches (it silently emits an empty `export {}`), and the
// cross-package relative paths it rewrites point back into the source directories.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = resolve(rootDir, ".types-tmp");
const entry = resolve(tmpDir, "core/src/index.d.ts");
const outFile = resolve(rootDir, "dist/index.d.ts");

rmSync(tmpDir, { recursive: true, force: true });

// 1) Emit the declarations
const tsc = spawnSync(
    "npx",
    ["tsc", "-p", "tsconfig.json", "--emitDeclarationOnly", "--outDir", ".types-tmp"],
    { cwd: rootDir, stdio: "inherit" },
);
if (tsc.status !== 0) {
    console.error("\n✗ Failed to emit the type declarations (tsc)");
    process.exit(tsc.status ?? 1);
}
if (!existsSync(entry)) {
    console.error(`\n✗ Declaration entry not found: ${entry}`);
    process.exit(1);
}

// 2) Roll it up into a single file
const config = ExtractorConfig.prepare({
    configObjectFullPath: undefined,
    packageJsonFullPath: resolve(rootDir, "package.json"),
    configObject: {
        projectFolder: rootDir,
        mainEntryPointFilePath: entry,
        compiler: {
            tsconfigFilePath: resolve(rootDir, "scripts/tsconfig.types.json"),
        },
        dtsRollup: { enabled: true, untrimmedFilePath: outFile },
        apiReport: { enabled: false },
        docModel: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
            compilerMessageReporting: { default: { logLevel: "none" } },
            extractorMessageReporting: { default: { logLevel: "none" } },
            tsdocMessageReporting: { default: { logLevel: "none" } },
        },
    },
});
const result = Extractor.invoke(config, { localBuild: true, showVerboseMessages: false });
rmSync(tmpDir, { recursive: true, force: true });
if (!result.succeeded) {
    console.error(
        `\n✗ Failed to roll up the type declarations (api-extractor): ${result.errorCount} error`,
    );
    process.exit(1);
}
console.log(`✓ dist/index.d.ts`);
