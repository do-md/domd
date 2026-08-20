// Release script: enter a version → build → print the npm publish instructions.
// It does not run npm publish itself; that last step is manual (the script prints the
// command).
//
// The kernel lives at .packages/@do-md/core/ inside the app repo: the app consumes this
// source directly through tsconfig paths (no release needed to develop against it), so
// publishing to npm is a separate act aimed at external consumers.
//
// The single source of truth for the version is `version` in the root package.json. This
// script rewrites it, and at build time vite's copy-dist-assets plugin injects it into
// dist/package.json. Publishing happens from dist/ (a complete package on its own — build
// output only, no src), so bumping the root version is the only edit needed.
//
// Usage: npm run release

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const pkgPath = resolve(rootDir, "package.json");
const distDir = resolve(rootDir, "dist");

function bump(version, kind) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!m) return null;
    let [major, minor, patch] = m.slice(1).map(Number);
    if (kind === "major") return `${major + 1}.0.0`;
    if (kind === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`; // patch / default
}

const isSemver = (v) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const suggested = bump(current, "patch");

console.log(`\n  Package  ${pkg.name}`);
console.log(`  Current  ${current}\n`);

const rl = createInterface({ input: stdin, output: stdout });
const answer = (
    await rl.question(
        `New version (Enter=patch→${suggested}, or major/minor/patch, or explicit x.y.z): `,
    )
).trim();
rl.close();

let next;
if (answer === "" || answer === "patch") next = suggested;
else if (answer === "major" || answer === "minor") next = bump(current, answer);
else next = answer;

if (!next || !isSemver(next)) {
    console.error(`\n✗ Invalid version: "${answer}"`);
    process.exit(1);
}
if (next === current) {
    console.error(
        `\n✗ New version is the same as the current one (${current}); npm rejects a republish`,
    );
    process.exit(1);
}

// 1) Write it back to the root package.json
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + "\n");
console.log(`\n✓ version ${current} → ${next}`);

// 2) build (vite's copy-dist-assets injects the new version into dist/package.json)
console.log(`\n▶ Building…\n`);
const build = spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    stdio: "inherit",
});
if (build.status !== 0) {
    console.error(
        `\n✗ Build failed, stopping here. The root package.json was already bumped to ${next}.`,
    );
    process.exit(build.status ?? 1);
}

// 3) Print the manual publish step (publish from dist/: it is a complete package on its
//    own, build output only, no src)
if (!existsSync(distDir)) {
    console.error(`\n✗ dist directory not found: ${distDir}`);
    process.exit(1);
}
console.log(`\n${"─".repeat(56)}`);
console.log(`Next, publish to npm by hand (from the dist directory, build output only):`);
console.log(`\n  cd ${distDir}`);
console.log(`  npm publish\n`);
console.log(
    `(dist/package.json sets publishConfig.access=public — the scoped package goes public)`,
);
console.log(`${"─".repeat(56)}\n`);
