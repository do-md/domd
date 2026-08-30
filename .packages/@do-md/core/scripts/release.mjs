// Release script: enter a version → build → commit the bump → print the push +
// npm publish instructions. It does not push or run npm publish itself; those
// last steps are manual (the script prints the commands).
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
// Git integration:
// - Releases cut from `main` only — checked up front, before anything is
//   mutated (a version published off a feature branch strands the release
//   commit when the branch is deleted; it happened).
// - After a successful build the version bump is committed automatically
//   (this file's package.json only — unrelated working-tree changes are
//   left alone), so the release flow is: npm run release → git push →
//   cd dist && npm publish.
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

function git(args) {
    return spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
}

// Guard: releases are cut from main, before anything is mutated. The kernel
// directory lives inside the app repo, so this resolves the APP repo's branch.
const branchResult = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branchResult.status !== 0) {
    console.error(`\n✗ Could not determine the git branch:\n${branchResult.stderr}`);
    process.exit(1);
}
const branch = branchResult.stdout.trim();
if (branch !== "main") {
    console.error(
        `\n✗ Releases are cut from main; current branch is "${branch}".` +
            `\n  Merge your work into main first, then release from there.`,
    );
    process.exit(1);
}

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

if (!existsSync(distDir)) {
    console.error(`\n✗ dist directory not found: ${distDir}`);
    process.exit(1);
}

// 3) Commit the bump — package.json only, by pathspec, so unrelated
//    working-tree changes are never swept into the release commit.
const commit = git([
    "commit",
    "-m",
    `Release ${pkg.name} v${next}`,
    "--",
    "package.json",
]);
if (commit.status !== 0) {
    console.error(
        `\n✗ Commit failed — the bump to ${next} is built but uncommitted:\n${commit.stderr || commit.stdout}`,
    );
    process.exit(1);
}
console.log(`✓ Committed: Release ${pkg.name} v${next}`);

// 4) Print the manual steps: push, then publish from dist/ (a complete
//    package on its own — build output only, no src)
console.log(`\n${"─".repeat(56)}`);
console.log(`Next, push the release commit and publish to npm by hand:`);
console.log(`\n  git push`);
console.log(`\n  cd ${distDir}`);
console.log(`  npm publish\n`);
console.log(
    `(dist/package.json sets publishConfig.access=public — the scoped package goes public)`,
);
console.log(`${"─".repeat(56)}\n`);
