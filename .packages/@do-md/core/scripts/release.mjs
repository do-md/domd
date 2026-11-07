// Release script: pick a version → build → commit the bump → print the push +
// npm publish instructions. It does not push or run npm publish itself; those
// last steps are manual (the script prints the commands). Same posture as the
// app's scripts/release.sh: the script picks and writes the version, after
// every check has passed.
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
// - The kernel directory must be committed: dist/ is built from the working
//   tree, and what goes to npm has to be a commit. Changes elsewhere in the
//   app repo are left alone.
// - After a successful build the version bump is committed automatically
//   (by pathspec — unrelated working-tree changes are never swept in), so
//   the release flow is: npm run release → git push → cd dist && npm publish.
// - The app's trilingual CHANGELOG rides along in the same commit: the
//   repo's scripts/changelog.mjs marks every `(kernel, unpublished)` entry
//   with the new version. It is validated before anything is mutated (the
//   CHANGELOG files must be committed and aligned) and applied right before
//   the commit. Skipped when the script is absent.
//
// Usage:
//   npm run release                 # asks: Enter = patch, or major/minor/patch, or x.y.z
//   npm run release -- minor        # no prompt
//   npm run release -- 0.15.0

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

// Guard: the kernel directory is built and published as is, so it must equal
// the commit. dist/ and node_modules/ are ignored, so they never show here.
const dirtyKernel = git(["status", "--porcelain", "--", "."]).stdout.trim();
if (dirtyKernel) {
    console.error(
        `\n✗ The kernel directory has uncommitted changes — commit or stash them first:\n${dirtyKernel}`,
    );
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const suggested = bump(current, "patch");

console.log(`\n  Package  ${pkg.name}`);
console.log(`  Current  ${current}\n`);

// The version comes from the command line (`npm run release -- minor`) or
// the prompt.
let answer = process.argv[2]?.trim();
if (answer === undefined) {
    const rl = createInterface({ input: stdin, output: stdout });
    answer = (
        await rl.question(
            `New version (Enter=patch→${suggested}, or major/minor/patch, or explicit x.y.z): `,
        )
    ).trim();
    rl.close();
}

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

// 0) Changelog preflight, before anything is mutated. The CHANGELOG files
//    live at the app repo root; their release transition is committed with
//    the bump, so they must not carry uncommitted edits of their own.
const repoRoot = git(["rev-parse", "--show-toplevel"]).stdout.trim();
const changelogScript = resolve(repoRoot, "scripts/changelog.mjs");
const changelogFiles = ["CHANGELOG.md", "CHANGELOG.zh-CN.md", "CHANGELOG.ja.md"].map(
    (file) => resolve(repoRoot, file),
);
// A prerelease (x.y.z-beta.1) does not release the Unreleased entries.
const isPrerelease = next.includes("-");
const hasChangelog = repoRoot !== "" && existsSync(changelogScript) && !isPrerelease;
if (isPrerelease) console.log(`\n· Prerelease ${next}: the CHANGELOG is left as is`);
const changelog = (...args) =>
    spawnSync(process.execPath, [changelogScript, ...args], {
        cwd: repoRoot,
        stdio: "inherit",
    });
if (hasChangelog) {
    const dirty = git(["status", "--porcelain", "--", ...changelogFiles]).stdout.trim();
    if (dirty) {
        console.error(
            `\n✗ The CHANGELOG files have uncommitted edits — commit them first:\n${dirty}`,
        );
        process.exit(1);
    }
    if (changelog("kernel", next, "--dry-run").status !== 0) {
        console.error(`\n✗ The CHANGELOG is not ready for kernel ${next}; nothing was changed.`);
        process.exit(1);
    }
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

// 3) Mark the kernel entries of the CHANGELOG with the new version.
if (hasChangelog && changelog("kernel", next).status !== 0) {
    console.error(
        `\n✗ CHANGELOG update failed — ${next} is built and bumped but uncommitted.` +
            `\n  Fix it, run: node scripts/changelog.mjs kernel ${next}  (in ${repoRoot}), then commit.`,
    );
    process.exit(1);
}

// 4) Commit the bump (and the CHANGELOG transition) by pathspec, so
//    unrelated working-tree changes are never swept into the release commit.
const commit = git([
    "commit",
    "-m",
    `Release ${pkg.name} v${next}`,
    "--",
    "package.json",
    ...(hasChangelog ? changelogFiles : []),
]);
if (commit.status !== 0) {
    console.error(
        `\n✗ Commit failed — the bump to ${next} is built but uncommitted:\n${commit.stderr || commit.stdout}`,
    );
    process.exit(1);
}
console.log(`✓ Committed: Release ${pkg.name} v${next}`);

// 5) Print the manual steps: push, then publish from dist/ (a complete
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
