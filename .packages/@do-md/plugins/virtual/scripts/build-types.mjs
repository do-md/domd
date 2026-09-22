// Generates the declarations we publish: dist/index.d.ts, one self-contained file.
//
// Plain `tsc --declaration` would emit one .d.ts per source file, cross-referencing each
// other with the same extensionless specifiers the sources use (see vite.config.ts for
// why they are extensionless). Bundler-resolution consumers cope with that; a consumer on
// node16/nodenext resolution does not, and gets "cannot find module ./target" on a
// package that otherwise works. Rolling the tree up into a single file removes the whole
// class of problem: the published declarations contain no relative specifiers at all.
//
// Same two-step shape as the kernel's scripts/build-types.mjs (tsc -> api-extractor).
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = resolve(rootDir, ".types-tmp");
const entry = resolve(tmpDir, "index.d.ts");
const outFile = resolve(rootDir, "dist/index.d.ts");

rmSync(tmpDir, { recursive: true, force: true });

// 1) Emit the declarations (rootDir is src/, so they land flat in .types-tmp/)
const tsc = spawnSync(
    "npx",
    ["tsc", "-p", "tsconfig.json", "--emitDeclarationOnly", "--outDir", ".types-tmp"],
    { cwd: rootDir, stdio: "inherit" },
);
if (tsc.status !== 0) {
    console.error("\n\u2717 Failed to emit the type declarations (tsc)");
    process.exit(tsc.status ?? 1);
}
if (!existsSync(entry)) {
    console.error(`\n\u2717 Declaration entry not found: ${entry}`);
    process.exit(1);
}

// 2) Roll it up into a single file. @do-md/core-react stays a bare import: it is a peer
//    dependency, not something to inline.
const config = ExtractorConfig.prepare({
    configObjectFullPath: undefined,
    packageJsonFullPath: resolve(rootDir, "package.json"),
    configObject: {
        projectFolder: rootDir,
        mainEntryPointFilePath: entry,
        compiler: { tsconfigFilePath: resolve(rootDir, "scripts/tsconfig.types.json") },
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
        `\n\u2717 Failed to roll up the type declarations (api-extractor): ${result.errorCount} error`,
    );
    process.exit(1);
}
console.log("\u2713 dist/index.d.ts");
