#!/usr/bin/env node
// Release-time transitions of the trilingual CHANGELOG (CHANGELOG.md,
// CHANGELOG.zh-CN.md, CHANGELOG.ja.md). Entries are written by hand, in the
// same commit as the change, into `## [Unreleased]`; this script only moves
// them from one state to the next when something is released, so the three
// files change in lockstep and nobody edits markers by hand.
//
//   node scripts/changelog.mjs check
//       The three files are aligned entry by entry (same sections, sub-
//       sections, entries, PR / issue numbers, credits, kernel markers and
//       footer links). Exit 1 when they are not.
//
//   node scripts/changelog.mjs kernel <x.y.z> [--dry-run]
//       @do-md/core-react x.y.z was published to npm: every
//       `*(kernel, unpublished)*` marker (in any section — an app release may
//       already have shipped the change from source) becomes
//       `*(kernel x.y.z)*`, and the Unreleased header lists x.y.z among the
//       kernel versions published since the last app release.
//       Run by .packages/@do-md/core/scripts/release.mjs.
//
//   node scripts/changelog.mjs app <x.y.z> [--date YYYY-MM-DD] [--dry-run]
//       The app was released as vx.y.z: Unreleased becomes
//       `## [x.y.z] - <date>` headed by the kernel version(s) it ships, a
//       fresh empty Unreleased goes on top, and the footer compare links move.
//       Refuses an empty Unreleased (pass --allow-empty to release anyway).
//       Run by scripts/release.sh.
//
// --dry-run computes and validates everything and writes nothing.
// --root <dir> points at another checkout (tests).
//
// Both release commands end by re-checking alignment, and warn about feat /
// fix / perf commits made since the changelog was last touched — likely
// user-facing changes that never got an entry.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SEMVER_G = /\d+\.\d+\.\d+/g;
const REPO_URL = "https://github.com/do-md/domd";

/** "a", "a and b", "a, b and c" — with the language's words. */
const joinList = (items, comma, and) =>
    items.length <= 1
        ? items.join("")
        : `${items.slice(0, -1).join(comma)}${and}${items[items.length - 1]}`;

const PKG = "`@do-md/core-react`";

const LANGS = [
    {
        file: "CHANGELOG.md",
        prefix: "Kernel:",
        unpublished: "*(kernel, unpublished)*",
        published: (v) => `*(kernel ${v})*`,
        // Unreleased header: kernel versions published since the last app
        // release, and what an unpublished marker means.
        unreleased: (versions, hasUnpublished) => {
            const pending =
                "entries marked *(kernel, unpublished)* ship in the next kernel release.";
            if (!versions.length) return hasUnpublished ? `Kernel: ${pending}` : null;
            const verb = versions.length > 1 ? "are" : "is";
            const head = `Kernel: ${PKG} ${joinList(versions, ", ", " and ")} ${verb} published on npm`;
            return hasUnpublished ? `${head}; ${pending}` : `${head}.`;
        },
        release: (versions) => `Kernel: ${PKG} ${versions.join(", ")}.`,
    },
    {
        file: "CHANGELOG.zh-CN.md",
        prefix: "内核：",
        unpublished: "*（内核，未发布）*",
        published: (v) => `*（内核 ${v}）*`,
        unreleased: (versions, hasUnpublished) => {
            const pending = "标 *（内核，未发布）* 的条目会随下一个内核版本发布。";
            if (!versions.length) return hasUnpublished ? `内核：${pending}` : null;
            const head = `内核：${PKG} ${joinList(versions, "、", " 和 ")} 已发布到 npm`;
            return hasUnpublished ? `${head}；${pending}` : `${head}。`;
        },
        release: (versions) => `内核：${PKG} ${versions.join("、")}。`,
    },
    {
        file: "CHANGELOG.ja.md",
        prefix: "カーネル：",
        unpublished: "*（カーネル、未公開）*",
        published: (v) => `*（カーネル ${v}）*`,
        unreleased: (versions, hasUnpublished) => {
            const pending = "*（カーネル、未公開）* の項目は次のカーネルリリースに含まれます。";
            if (!versions.length) return hasUnpublished ? `カーネル：${pending}` : null;
            const head = `カーネル：${PKG} ${joinList(versions, "、", " と ")} は npm で公開済みです。`;
            return hasUnpublished ? `${head}${pending}` : head;
        },
        release: (versions) => `カーネル：${PKG} ${versions.join("、")}。`,
    },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const fail = (message) => {
    const error = new Error(message);
    error.expected = true;
    throw error;
};

/** Split a changelog into the text before Unreleased, the Unreleased section
 *  (heading excluded) and everything from the next version heading on. */
const splitUnreleased = (text, file) => {
    const heading = "## [Unreleased]";
    const start = text.indexOf(`\n${heading}\n`);
    if (start === -1) fail(`${file}: no "${heading}" section`);
    const bodyStart = start + heading.length + 2;
    const next = text.indexOf("\n## [", bodyStart);
    const footer = text.search(/\n\[[^\]]+\]: /);
    const bodyEnd = next !== -1 ? next + 1 : footer !== -1 ? footer + 1 : text.length;
    return {
        before: text.slice(0, bodyStart),
        body: text.slice(bodyStart, bodyEnd),
        after: text.slice(bodyEnd),
    };
};

/** The Unreleased header line (the kernel line before the first subsection)
 *  and the body without it. */
const splitHeader = (body, lang) => {
    const lines = body.split("\n");
    const index = lines.findIndex(
        (line, i) =>
            line.startsWith(lang.prefix) &&
            !lines.slice(0, i).some((prior) => prior.startsWith("### ")),
    );
    if (index === -1) return { header: null, rest: body };
    const rest = [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n");
    return { header: lines[index], rest };
};

const tidy = (body) => body.replace(/^\n+/, "").replace(/\n+$/, "");

const unreleasedLinkRe = /^\[Unreleased\]: (\S+)\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD$/m;

// ---------------------------------------------------------------------------
// Alignment check (one outline per file, compared to the English one)
// ---------------------------------------------------------------------------

const SUBSECTION = {
    Added: "A", Changed: "C", Removed: "R", Fixed: "F",
    新增: "A", 变更: "C", 移除: "R", 修复: "F",
    追加: "A", 変更: "C", 削除: "R", 修正: "F",
};

const outline = (text) => {
    const entries = [];
    let version = null;
    let sub = null;
    for (const line of text.split("\n")) {
        let m = /^## \[(.+?)\]/.exec(line);
        if (m) {
            version = m[1];
            sub = null;
            continue;
        }
        m = /^### (.+)$/.exec(line);
        if (m) {
            sub = SUBSECTION[m[1].trim()] ?? `?${m[1]}`;
            continue;
        }
        m = /^(\s*)- (.*)$/.exec(line);
        if (!m || !version) continue;
        const uniq = (re) => [...new Set([...line.matchAll(re)].map((x) => x[1]))].sort().join(",");
        entries.push(
            [
                version,
                sub,
                m[1].length,
                uniq(/\/(?:pull|issues)\/(\d+)/g),
                uniq(/github\.com\/([A-Za-z0-9-]+)\)/g),
                /\*[(（](kernel|内核|カーネル)/.test(line),
                /^\*\*(Kernel API|内核 API|カーネル API)/.test(m[2]),
                (/(\d+\.\d+\.\d+)[)）]\*$/.exec(line) ?? [])[1] ?? "",
                /(unpublished|未发布|未公開)[)）]\*$/.test(line),
            ].join("|"),
        );
    }
    const links = text.split("\n").filter((line) => /^\[[^\]]+\]: /.test(line));
    return { entries, links };
};

const checkAligned = (texts) => {
    const problems = [];
    const base = outline(texts[0]);
    LANGS.slice(1).forEach((lang, i) => {
        const other = outline(texts[i + 1]);
        if (other.entries.length !== base.entries.length) {
            problems.push(
                `${lang.file}: ${other.entries.length} entries, ${LANGS[0].file} has ${base.entries.length}`,
            );
        }
        const at = base.entries.findIndex((entry, k) => entry !== other.entries[k]);
        if (at !== -1 && at < other.entries.length) {
            problems.push(
                `${lang.file}: entry ${at + 1} differs\n    en: ${base.entries[at]}\n    ${lang.file}: ${other.entries[at]}`,
            );
        }
        if (other.links.join("\n") !== base.links.join("\n")) {
            problems.push(`${lang.file}: footer links differ from ${LANGS[0].file}`);
        }
    });
    return problems;
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** kernel x.y.z published on npm. */
const releaseKernel = (texts, version) => {
    let marked = 0;
    const out = texts.map((text, i) => {
        const lang = LANGS[i];
        const { before, body, after } = splitUnreleased(text, lang.file);
        // The header explains the unpublished marker in its own words; it is
        // regenerated below, so only the entries' markers are rewritten.
        const { header, rest } = splitHeader(body, lang);
        const versions = header ? header.match(SEMVER_G) ?? [] : [];
        if (versions.includes(version)) {
            fail(`${lang.file}: kernel ${version} is already listed as published`);
        }
        const mark = (part) => part.split(lang.unpublished).join(lang.published(version));
        const count = [before, rest, after].join("").split(lang.unpublished).length - 1;
        if (i === 0) marked = count;
        else if (count !== marked) {
            fail(`${lang.file}: ${count} unpublished kernel markers, ${LANGS[0].file} has ${marked}`);
        }
        const line = lang.unreleased([...versions, version], false);
        const content = tidy(mark(rest));
        return `${mark(before)}\n${line}\n\n${content ? `${content}\n\n` : ""}${mark(after)}`;
    });
    return { out, summary: `kernel ${version}: ${marked} entr${marked === 1 ? "y" : "ies"} marked` };
};

/** app vx.y.z released. */
const releaseApp = (texts, version, date, embeddedKernel, allowEmpty) => {
    let previous = null;
    const out = texts.map((text, i) => {
        const lang = LANGS[i];
        if (text.includes(`\n## [${version}]`)) fail(`${lang.file}: section [${version}] already exists`);
        const link = unreleasedLinkRe.exec(text);
        if (!link) fail(`${lang.file}: no "[Unreleased]: …/compare/vX.Y.Z...HEAD" footer link`);
        const [, repo, prev] = link;
        if (previous !== null && prev !== previous) fail(`${lang.file}: footer says previous release v${prev}`);
        previous = prev;
        if (prev === version) fail(`${lang.file}: v${version} is already the last release`);

        const { before, body, after } = splitUnreleased(text, lang.file);
        const { header, rest } = splitHeader(body, lang);
        const content = tidy(rest);
        if (!/^\s*- /m.test(content) && !allowEmpty) {
            fail(`${lang.file}: Unreleased has no entries — write them first, or pass --allow-empty`);
        }
        const published = header ? header.match(SEMVER_G) ?? [] : [];
        const kernel = lang.release(published.length ? published : [embeddedKernel]);
        const section = `## [${version}] - ${date}\n\n${kernel}\n\n${content ? `${content}\n\n` : ""}`;
        const footer = after.replace(
            unreleasedLinkRe,
            `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/compare/v${prev}...v${version}`,
        );
        return `${before}\n${section}${footer}`;
    });
    return { out, summary: `app v${version} (${date}), previous v${previous}` };
};

// ---------------------------------------------------------------------------
// Missing-entry reminder
// ---------------------------------------------------------------------------

const git = (root, args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** feat / fix / perf commits since the changelog was last touched: by the
 *  convention every user-facing commit carries its own entry, so these most
 *  likely never got one. `paths` narrows to the kernel for a kernel release. */
const warnMissing = (root, paths) => {
    try {
        const last = git(root, ["log", "-1", "--format=%H", "--", LANGS[0].file]);
        if (!last) return;
        const log = git(root, ["log", "--format=%h %s", `${last}..HEAD`, "--", ...paths]);
        const suspects = log
            .split("\n")
            .filter((line) => /^\S+ (feat|fix|perf)(\(.+?\))?!?:/.test(line));
        if (!suspects.length) return;
        console.warn(
            `\n⚠ ${suspects.length} feat/fix commit(s) since the changelog was last edited — check they have entries:`,
        );
        for (const line of suspects) console.warn(`    ${line}`);
    } catch {
        // Not a git checkout (tests): nothing to remind about.
    }
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const main = () => {
    const args = process.argv.slice(2);
    const flag = (name) => {
        const i = args.indexOf(name);
        if (i === -1) return undefined;
        args.splice(i, 1);
        return true;
    };
    const option = (name) => {
        const i = args.indexOf(name);
        if (i === -1) return undefined;
        const value = args[i + 1];
        args.splice(i, 2);
        return value;
    };
    const dryRun = flag("--dry-run");
    const allowEmpty = flag("--allow-empty");
    const date = option("--date") ?? new Date().toLocaleDateString("sv-SE");
    const root = resolve(option("--root") ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    const [command, version] = args;

    const paths = LANGS.map((lang) => resolve(root, lang.file));
    const texts = paths.map((path) => readFileSync(path, "utf8"));

    if (command === "check") {
        const problems = checkAligned(texts);
        if (problems.length) fail(`CHANGELOG files are not aligned:\n  ${problems.join("\n  ")}`);
        console.log(`✓ CHANGELOG aligned (${outline(texts[0]).entries.length} entries)`);
        return;
    }
    if (command !== "kernel" && command !== "app") {
        fail("usage: changelog.mjs check | kernel <x.y.z> | app <x.y.z> [--date YYYY-MM-DD] [--dry-run]");
    }
    if (!version || !SEMVER.test(version)) fail(`invalid version "${version ?? ""}" (expected x.y.z)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`invalid --date "${date}" (expected YYYY-MM-DD)`);

    const before = checkAligned(texts);
    if (before.length) fail(`CHANGELOG files are not aligned before the release:\n  ${before.join("\n  ")}`);

    let result;
    if (command === "kernel") {
        result = releaseKernel(texts, version);
    } else {
        const kernelPkg = resolve(root, ".packages/@do-md/core/package.json");
        const embedded = JSON.parse(readFileSync(kernelPkg, "utf8")).version;
        result = releaseApp(texts, version, date, embedded, allowEmpty);
    }

    const after = checkAligned(result.out);
    if (after.length) fail(`the transition broke alignment:\n  ${after.join("\n  ")}`);

    if (!dryRun) result.out.forEach((text, i) => writeFileSync(paths[i], text));
    console.log(`${dryRun ? "✓ CHANGELOG ready" : "✓ CHANGELOG updated"} — ${result.summary}`);
    warnMissing(root, command === "kernel" ? [".packages/@do-md/core"] : []);
};

try {
    main();
} catch (error) {
    if (!error.expected) throw error;
    console.error(`✗ changelog: ${error.message}`);
    process.exit(1);
}
