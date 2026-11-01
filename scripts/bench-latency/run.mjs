// Long-document latency benchmark for the DOMD kernel, measured the way
// ponjo's test/perf/latency.test.js measures its views (ponjo-app/ponjo#212):
// open a doc, put the caret near its start, type 40 characters 150 ms apart
// while a teammate's edit arrives after every second key, and time the open,
// each key, each teammate edit and the longest task after the open.
//
//   node run.mjs                         all cases, both configs, 3 runs
//   node run.mjs --electron <binary>     in that Electron (same engine as ponjo's run)
//   node run.mjs --cases blocks-100k,verses-10k --configs B --runs 1
//   node run.mjs --cases blocks-1m --configs B --runs 1 --profile typing --no-minify
//                                        CPU profile of the open or the typing phase
//
// Each run gets a fresh browser. Results go to results/<stamp>.json and a
// Markdown table is printed.

import { build } from 'esbuild';
import { chromium, _electron } from 'playwright';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, loadavg } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

// ponjo's LATENCY (web/views/index.js) for the columns it promises.
const LATENCY = { open: 3000, keystroke: { median: 30, p95: 100 }, teammate: { median: 50, p95: 100 }, task: 500 };

// ponjo's cases (test/perf/latency.test.js) and the shapes ponjo#212 cites.
const CASES = [
  ['blocks-100k', 'blocks', 100_000, 'ponjo: Markdown view limit'],
  ['verses-10k', 'verses', 10_000, 'ponjo: Markdown view, one long block'],
  ['blocks-200k', 'blocks', 200_000, '#212: opened in 4.4 s'],
  ['blocks-1m', 'blocks', 1_000_000, '#212: opened in 33 s'],
  ['verses-20k', 'verses', 20_000, '#212: one 20 KB paragraph, p95 145 ms'],
  ['blocks-5m', 'blocks', 5_000_000, 'ponjo: plain view limit'],
  ['verses-200k', 'verses', 200_000, 'one paragraph, for the scaling curve'],
  ['verses-1m', 'verses', 1_000_000, 'one paragraph, for the scaling curve'],
  ['verses-4.5m', 'verses', 4_500_000, '#212: a Bible, one paragraph'],
  ['verses-5m', 'verses', 5_000_000, 'ponjo: plain view limit, verses'],
];
const CONFIGS = {
  A: { virtual: false, teammatePath: 'text', label: 'kernel only; teammate edit by text offset (replaceRanges)' },
  B: { virtual: true, teammatePath: 'text', label: 'kernel + @do-md/virtual (auto); teammate edit by text offset (replaceRanges)' },
  C: { virtual: true, teammatePath: 'ops', label: 'kernel + @do-md/virtual (auto); teammate edit as DOMD ops (applyExternalRenderDataOps), delivered in order with no CRDT' },
};

const pick = arg('cases', 'all');
const cases = pick === 'all' ? CASES : CASES.filter(([id]) => pick.split(',').includes(id));
const configs = arg('configs', 'A,B,C').split(',');
const runs = Number(arg('runs', '3'));
const timeoutMs = Number(arg('timeout-min', '10')) * 60_000;
const electronPath = arg('electron', null);
const profilePhase = arg('profile', null); // 'open' | 'typing'
const minify = !args.includes('--no-minify');
const caretBy = arg('caret', 'dom'); // 'dom' (ponjo's caretAt) | 'model'

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
// ponjo's percentile, so p95 of 40 samples is the same sample in both.
const percentile = (ms, q) => [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(q * ms.length))];
const median = (xs) => percentile(xs, 0.5);

async function buildPage() {
  const dir = await mkdtemp(join(tmpdir(), 'domd-bench-'));
  const virtualSrc = join(app, '.packages', '@do-md', 'plugins', 'virtual', 'src', 'index.ts');
  const zenithSrc = join(app, '.packages', '@do-md', 'zenith');
  const common = {
    bundle: true,
    minify,
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [join(here, 'node_modules')],
    tsconfig: join(here, 'tsconfig.bench.json'),
    logLevel: 'error',
  };
  const worker = await build({ ...common, entryPoints: [join(here, 'peer-worker.js')], format: 'iife', write: false });
  await build({
    entryPoints: [join(here, 'page.jsx')],
    outdir: dir,
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    minify,
    define: { 'process.env.NODE_ENV': '"production"', __PEER_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
    // @do-md/virtual is not on npm: bundle its source from this repo, with
    // the zenith store it is written against, as the app does. Everything
    // else, the kernel included, resolves to this folder's node_modules.
    alias: { '@do-md/virtual': virtualSrc, '@do-md/zenith': zenithSrc },
    nodePaths: [join(here, 'node_modules')],
    tsconfig: join(here, 'tsconfig.bench.json'),
    metafile: true,
    logLevel: 'error',
  }).then((result) => {
    // Exactly one kernel, the published one.
    const inputs = Object.keys(result.metafile.inputs);
    const kernels = inputs.filter((f) => f.includes('@do-md/core/') || f.includes('@do-md/core-react/'));
    if (kernels.some((f) => !f.includes('node_modules/@do-md/core-react/'))) throw new Error(`kernel source leaked into the bundle: ${kernels.join(', ')}`);
  });
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>domd-bench</title>
<link rel="stylesheet" href="page.css"><style>html,body{margin:0}</style><div id="root"></div><script src="page.js"></script>`);
  return join(dir, 'index.html');
}

const BROWSER_FLAGS = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-smooth-scrolling'];

async function open(pageFile) {
  if (electronPath) {
    const electron = await _electron.launch({ executablePath: electronPath, args: [join(here, 'electron-main.cjs')], env: { ...process.env, BENCH_PAGE: pageFile } });
    const page = await electron.firstWindow();
    return { page, close: () => electron.close().catch(() => {}) };
  }
  const browser = await chromium.launch({ headless: false, args: BROWSER_FLAGS });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(pathToFileURL(pageFile).href);
  return { page, close: () => browser.close().catch(() => {}) };
}

// Self and inclusive time per function from a CPU profile, top `n` of each.
function hotspots(profile, n = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const key = (node) => {
    const { functionName, url, lineNumber } = node.callFrame;
    return `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber + 1}`;
  };
  const self = new Map();
  const inclusive = new Map();
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const node = byId.get(id);
    self.set(key(node), (self.get(key(node)) ?? 0) + dt);
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const k = key(byId.get(at));
      if (seen.has(k)) continue;
      seen.add(k);
      inclusive.set(k, (inclusive.get(k) ?? 0) + dt);
    }
  });
  const top = (map) => [...map].filter(([k]) => !k.startsWith('(root)') && !k.startsWith('(program)') && !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ fn: k, ms: Math.round(ms) }));
  return { self: top(self), inclusive: top(inclusive) };
}

async function measure(pageFile, [, shape, chars], config) {
  const { page, close } = await open(pageFile);
  const killer = setTimeout(close, timeoutMs);
  const out = { phase: 'start' };
  try {
    out.pageErrors = [];
    page.on('pageerror', (error) => {
      const at = { phase: out.phase, message: String(error.message).slice(0, 300), stack: String(error.stack ?? '').split('\n').slice(0, 8).join('\n') };
      out.pageErrors.push(at);
      console.log(`  page error in ${out.phase}: ${at.message}\n${at.stack}`);
    });
    await page.waitForFunction(() => window.bench?.ready, null, { timeout: 30_000 });
    out.engine = await page.evaluate(() => bench.info());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    const profiling = async (phase) => {
      if (profilePhase !== phase) return;
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    };
    const profiled = async (phase) => {
      if (profilePhase !== phase) return;
      const { profile } = await cdp.send('Profiler.stop');
      await mkdir(join(here, 'results'), { recursive: true });
      const file = join(here, 'results', `profile-${shape}-${chars}-${config}-${phase}-${Date.now()}.cpuprofile`);
      await writeFile(file, JSON.stringify(profile));
      out.profile = { file, ...hotspots(profile) };
    };

    out.phase = 'open';
    await profiling('open');
    let start = Date.now();
    // A long load logs where it stands every 30 s.
    out.loadProgress = [];
    const poll = setInterval(() => {
      page.evaluate(() => bench.progress()).then((p) => {
        const at = { s: Math.round((Date.now() - start) / 1000), ...p };
        out.loadProgress.push(at);
        console.log(`  loading ${shape}-${chars} ${config}: ${JSON.stringify(at)}`);
      }).catch(() => {});
    }, 30_000);
    out.open = await page.evaluate((a) => bench.make(a), { shape, chars, virtual: CONFIGS[config].virtual, teammatePath: CONFIGS[config].teammatePath }).finally(() => clearInterval(poll));
    out.open.wallMs = Date.now() - start;
    await profiled('open');

    out.phase = 'caret';
    out.caret = await page.evaluate((by) => bench.caretAt(0.001, by), caretBy);

    out.phase = 'typing';
    await profiling('typing');
    const raw = [];
    for (let k = 0; k < 40; k++) {
      start = Date.now();
      await cdp.send('Input.insertText', { text: 'x' });
      raw.push(Date.now() - start);
      await page.evaluate(() => bench.keyPainted());
      if (k % 2) await page.evaluate(() => bench.inject());
      await wait(150);
    }
    await profiled('typing');
    out.phase = 'finish';
    const done = await page.evaluate(() => bench.finish());
    const strict = done.strictKeyMs.filter((x) => x !== null);
    const sync = done.teammate.map((t) => t.syncMs);
    const frame = done.teammate.map((t) => t.frameMs);
    Object.assign(out, {
      phase: 'done',
      keystroke: { median: median(raw), p95: percentile(raw, 0.95) },
      keystrokeToFrame: { median: median(strict), p95: percentile(strict, 0.95), samples: strict.length },
      teammate: { median: median(sync), p95: percentile(sync, 0.95) },
      teammateToFrame: { median: median(frame), p95: percentile(frame, 0.95) },
      teammateFailed: done.teammate.reduce((n, t) => n + t.failed, 0),
      flushes: { count: done.flushes.length, median: done.flushes.length ? median(done.flushes.map((f) => f.ms)) : 0, max: Math.max(0, ...done.flushes.map((f) => f.ms)) },
      task: done.longestTask,
      check: done.check,
      heapMB: done.heapMB,
    });
  } catch (error) {
    out.error = String(error.message ?? error).split('\n')[0];
  } finally {
    clearTimeout(killer);
    await close();
  }
  return out;
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const pair = (m) => `${Math.round(m.median)}/${Math.round(m.p95)} ms`;

function summarize(results) {
  const rows = [];
  for (const [id, , chars, note] of cases) {
    for (const config of configs) {
      const all = results.filter((r) => r.case === id && r.config === config);
      const ok = all.filter((r) => r.phase === 'done');
      if (!ok.length) {
        const r = all[0] ?? {};
        rows.push({ id, config, chars, note, failed: `${r.error ? 'error' : 'timeout'} in ${r.phase}${r.error ? `: ${r.error}` : ''}`, runs: all.length });
        continue;
      }
      // The run in the middle by first-editable open, and the worst of each.
      const mid = [...ok].sort((a, b) => a.open.fullMs - b.open.fullMs)[Math.floor((ok.length - 1) / 2)];
      rows.push({
        id, config, chars, note, runs: ok.length, of: all.length,
        firstEditable: median(ok.map((r) => r.open.firstEditableMs)),
        full: median(ok.map((r) => r.open.fullMs)),
        fullWorst: Math.max(...ok.map((r) => r.open.fullMs)),
        keystroke: mid.keystroke, keystrokeToFrame: mid.keystrokeToFrame,
        teammate: mid.teammate, teammateToFrame: mid.teammateToFrame,
        task: median(ok.map((r) => r.task)), taskWorst: Math.max(...ok.map((r) => r.task)),
        loadTask: median(ok.map((r) => r.open.longestLoadTask)),
        flushMax: Math.max(...ok.map((r) => r.flushes.max)),
        checks: ok.every((r) => r.check.ok) ? 'ok' : `FAILED ${ok.filter((r) => !r.check.ok).length}/${ok.length}`,
        teammateFailed: ok.reduce((n, r) => n + r.teammateFailed, 0),
        blocks: mid.open.topLevelBlocks, heapMB: mid.heapMB,
      });
    }
  }
  const lines = [
    '| Case | Config | Open (first editable / whole doc) | Keystroke | Key → next frame | Teammate | Teammate → next frame | Longest task (after open / during load) | Typed text intact |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const name = `${r.id} (${r.chars.toLocaleString('en')} chars)`;
    if (r.failed) {
      lines.push(`| ${name} | ${r.config} | ${r.failed} | | | | | | |`);
      continue;
    }
    lines.push(`| ${name} | ${r.config} | ${fmtMs(r.firstEditable)} / ${fmtMs(r.full)} | ${pair(r.keystroke)} | ${pair(r.keystrokeToFrame)} | ${pair(r.teammate)} | ${pair(r.teammateToFrame)} | ${fmtMs(r.task)} / ${fmtMs(r.loadTask)} | ${r.checks}${r.teammateFailed ? `, ${r.teammateFailed} teammate edits failed` : ''} |`);
  }
  return { rows, table: lines.join('\n') };
}

function machine() {
  const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return null; } };
  return {
    cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30),
    os: sh('sw_vers -productVersion') ?? process.platform, power: sh('pmset -g batt | head -1'),
    node: process.version, loadavgAtStart: loadavg().map((x) => x.toFixed(2)),
  };
}

const pageFile = await buildPage();
const env = { minify, caretBy, machine: machine(), electron: electronPath, kernel: '@do-md/core-react@0.13.1 (npm)', virtual: `.packages/@do-md/plugins/virtual/src @ ${execSync('git rev-parse --short HEAD', { cwd: app, encoding: 'utf8' }).trim()}` };
console.log(JSON.stringify(env));
const results = [];
await mkdir(join(here, 'results'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// Every run is appended as it finishes, so a stopped run loses nothing.
const lines = join(here, 'results', `${stamp}.jsonl`);
await writeFile(lines, `${JSON.stringify({ env })}\n`);
for (const c of cases) {
  for (const config of configs) {
    for (let run = 0; run < runs; run++) {
      const got = await measure(pageFile, c, config);
      results.push({ case: c[0], config, run, ...got });
      await appendFile(lines, `${JSON.stringify(results.at(-1))}\n`);
      const o = got.open;
      console.log(`# ${c[0]} ${config} run ${run + 1}: ${got.phase === 'done'
        ? `open ${fmtMs(o.firstEditableMs)}/${fmtMs(o.fullMs)} key ${pair(got.keystroke)} frame ${pair(got.keystrokeToFrame)} teammate ${pair(got.teammate)} task ${fmtMs(got.task)} load-task ${fmtMs(o.longestLoadTask)} check ${got.check.ok ? 'ok' : JSON.stringify(got.check)}`
        : `stopped in ${got.phase}${got.error ? `: ${got.error}` : ' (timeout)'}${o ? ` open ${JSON.stringify(o)}` : ''}`}`);
      if (got.profile) {
        console.log(`  profile ${got.profile.file}`);
        console.log('  inclusive:\n' + got.profile.inclusive.slice(0, 20).map((h) => `    ${h.ms} ms  ${h.fn}`).join('\n'));
        console.log('  self:\n' + got.profile.self.slice(0, 15).map((h) => `    ${h.ms} ms  ${h.fn}`).join('\n'));
      }
      // Stop repeating a case that cannot finish: one timeout is the result.
      if (got.phase !== 'done') break;
    }
  }
}
const { rows, table } = summarize(results);
const file = join(here, 'results', `${stamp}.json`);
await writeFile(file, JSON.stringify({ env, latency: LATENCY, results, rows }, null, 2));
console.log(`\n${table}\n\nresults: ${file}`);
