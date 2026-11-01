// The bench page: the published DOMD kernel (@do-md/core-react from npm)
// alone, optionally wrapped in @do-md/virtual, with no app features. run.mjs
// drives it the way ponjo's test/perf/latency.test.js drives its views.
//
// Instrumentation is read-only: it observes events, frames, long tasks and
// wraps two store methods on the instance to time them. Kernel behaviour,
// including when it commits typed text to the model, is left as shipped.

import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DOMD, DOMDProvider, EditorStore } from '@do-md/core-react';
import '@do-md/core-react/style.css';
import { VirtualStoreProvider, VirtualViewport } from '@do-md/virtual';
import { blocks, verses } from './shapes.mjs';

const longtasks = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longtasks.push({ start: e.startTime, duration: e.duration });
}).observe({ type: 'longtask', buffered: true });

// Resolves once the frame after the current task has been produced: a rAF
// callback, then a message task queued behind that frame's rendering.
const afterFrame = () => new Promise((done) => requestAnimationFrame(() => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => done(performance.now());
  channel.port2.postMessage(0);
}));
const nextFrame = () => new Promise((done) => requestAnimationFrame(() => done()));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function App({ store, virtual }) {
  const scrollRef = useRef(null);
  return (
    <div ref={scrollRef} id="scroller" style={{ height: '100vh', overflowY: 'auto' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 32px' }}>
        <VirtualStoreProvider>
          <DOMDProvider store={store}>
            <VirtualViewport scrollRef={scrollRef} mode={virtual ? 'auto' : 'off'}>
              <DOMD />
            </VirtualViewport>
          </DOMDProvider>
        </VirtualStoreProvider>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
const editable = () => document.querySelector('[contenteditable="true"]');

let store = null;
// The teammate for the 'ops' path: peer-worker.js in a worker (its code is
// inlined by run.mjs as __PEER_WORKER__; a blob worker also loads from file://).
let peer = null;
let peerWaiter = null;
const peerAsk = (message) => new Promise((done) => { peerWaiter = done; peer.postMessage(message); });
let md0 = '';
let caret = 0;
let tOpened = 0;
let injecting = false;
const keys = []; // one per beforeinput: { ts, painted }
const teammate = []; // one per injected edit
const flushes = []; // applyPendingText_ calls that had typed text to commit
const loadTicks = []; // appendMarkdownIncremental_ calls (chunked load)
let lastKey = Promise.resolve();

window.addEventListener('beforeinput', (e) => {
  if (e.inputType !== 'insertText') return;
  const key = { ts: e.timeStamp, painted: 0 };
  keys.push(key);
  lastKey = afterFrame().then((t) => { key.painted = t; });
}, { capture: true, passive: true });

function instrument(s) {
  const flush = s.applyPendingText_;
  s.applyPendingText_ = function (...args) {
    const had = Boolean(this.pendingInput_) && !this.duringComposition && this.isEditable;
    const start = performance.now();
    const result = flush.apply(this, args);
    if (had) flushes.push({ at: start, ms: performance.now() - start, by: injecting ? 'teammate' : 'debounce' });
    return result;
  };
  const append = s.appendMarkdownIncremental_;
  s.appendMarkdownIncremental_ = function (...args) {
    const start = performance.now();
    const result = append.apply(this, args);
    loadTicks.push({ at: start, ms: performance.now() - start });
    return result;
  };
}

window.bench = {
  ready: true,
  info: () => ({ userAgent: navigator.userAgent, chrome: navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) }),

  // Open a doc: text → an editable view (first chunk) → the whole doc loaded.
  async make({ shape, chars, virtual, teammatePath = 'text' }) {
    const text = shape === 'verses' ? verses(chars) : blocks(chars);
    await afterFrame();
    const t0 = performance.now();
    // As the app opens a file: a store constructed with the text (it parses
    // the first 500 lines at once and streams the rest in idle callbacks).
    store = new EditorStore({ editable: true, initMd: text });
    const tStore = performance.now();
    instrument(store);
    root.render(<App store={store} virtual={virtual} />);
    while (!(editable()?.childElementCount > 0)) await nextFrame();
    const tFirst = await afterFrame();
    if (store.isLoadingChunks) {
      await new Promise((done) => {
        const off = store.subscribeLoadingChange((loading) => {
          if (!loading) { off(); done(); }
        });
        if (!store.isLoadingChunks) { off(); done(); }
      });
    }
    const tFull = await afterFrame();
    tOpened = tFull;
    md0 = store.toMarkdown();
    if (teammatePath === 'ops') {
      // DOMD's own collaboration path: the teammate is a headless store in a
      // worker, seeded from the same tree; the two exchange RenderDataOps.
      peer = new Worker(URL.createObjectURL(new Blob([__PEER_WORKER__], { type: 'text/javascript' })));
      peer.onmessage = ({ data }) => { const waiter = peerWaiter; peerWaiter = null; waiter?.(data); };
      const ready = await peerAsk({ type: 'init', snapshot: store.getRenderDataSnapshot() });
      if (ready.chars !== md0.length) throw new Error('teammate store did not start from the same doc');
      store.subscribeRenderDataOps((ops) => { peer.postMessage({ type: 'ops', ops }); });
      // Setting the teammate up is not part of the open.
      tOpened = await afterFrame();
    }
    return {
      chars: text.length,
      storeMs: tStore - t0,
      firstEditableMs: tFirst - t0,
      fullMs: tFull - t0,
      canonicalChars: md0.length,
      canonicalSameAsInput: md0 === text,
      topLevelBlocks: store.getTopLevelBlockCount(),
      domElements: document.getElementsByTagName('*').length,
      loadTicks: loadTicks.length,
      loadTickMs: { first: loadTicks[0]?.ms ?? 0, last: loadTicks.at(-1)?.ms ?? 0, max: Math.max(0, ...loadTicks.map((t) => t.ms)), sum: loadTicks.reduce((n, t) => n + t.ms, 0) },
      longestLoadTask: Math.max(0, ...longtasks.filter((t) => t.start >= t0 && t.start <= tFull).map((t) => t.duration)),
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
    };
  },

  // Put the caret at place `r` (0 to 1) along the editable's text, as
  // ponjo's caretAt does: a DOM range in the text nodes, then focus.
  async caretAt(r, by = 'dom') {
    const el = editable();
    if (by === 'model') {
      // r along the whole doc's text, also when only a window of it is in
      // the DOM (virtualization), placed through the kernel's own API.
      store.setSelection({ start: Math.floor(r * md0.length) });
      store.focus();
      await sleep(10);
      await afterFrame();
      caret = store.getSelectionOffsets()?.start ?? -1;
      return { caret, by, focused: document.activeElement === el, context: md0.slice(Math.max(0, caret - 20), caret + 20) };
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const total = nodes.reduce((n, node) => n + node.data.length, 0);
    let at = Math.floor(r * total);
    const node = nodes.find((n) => (at -= n.data.length) <= 0) ?? nodes.at(-1);
    el.focus();
    const range = document.createRange();
    range.setStart(node, node.data.length + Math.min(0, at));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await sleep(10);
    await afterFrame();
    const offsets = store.getSelectionOffsets();
    caret = offsets?.start ?? -1;
    return { caret, focused: document.activeElement === el, context: md0.slice(Math.max(0, caret - 20), caret + 20) };
  },

  // Where a load stands (polled by run.mjs while make() is in flight).
  progress: () => ({ ticks: loadTicks.length, lastTickMs: loadTicks.at(-1)?.ms ?? 0, tickMsSum: loadTicks.reduce((n, t) => n + t.ms, 0), loading: store?.isLoadingChunks ?? null }),

  keyPainted: () => lastKey,

  // A teammate's edit arriving: 'y' three characters before the end, through
  // the kernel's text-addressed replace API (the shape of ponjo's text ops).
  // The offset is worked out without reading the store, so reading it does
  // not commit typed text early; the call itself commits it, as it must.
  async inject() {
    let result;
    let ms;
    let start;
    if (peer) {
      // Delivered in order, with no CRDT in between: two stores exchanging
      // raw ops do not merge concurrent edits (DOMD's collaboration runs
      // them through Yjs for that), so first our typed text is committed
      // and its ops reach the teammate, then the teammate types 'y' three
      // characters before the end of its copy, then its ops land here.
      // Timed: committing our typed text, and applying the teammate's ops.
      start = performance.now();
      injecting = true;
      await store.flushPendingInput();
      injecting = false;
      const committed = performance.now();
      result = await peerAsk({ type: 'edit' });
      const arrived = performance.now();
      injecting = true;
      await store.applyExternalRenderDataOps(result.ops);
      injecting = false;
      const applied = performance.now();
      ms = committed - start + (applied - arrived);
      start = applied - ms; // so the frame time below adds onto the timed part only
    } else {
      const typed = keys.length;
      const at = md0.length + typed + teammate.length - 3;
      start = performance.now();
      injecting = true;
      result = store.replaceRanges({ start: at, end: at, text: 'y' });
      injecting = false;
      ms = performance.now() - start;
    }
    const edit = { syncMs: ms, frameMs: 0, applied: result.applied, failed: result.failed };
    teammate.push(edit);
    edit.frameMs = (await afterFrame()) - start;
    return edit;
  },

  // Let typing settle (the kernel commits a typing burst 400 ms after the
  // last key), then check nothing typed was lost or misplaced.
  async finish() {
    await sleep(800);
    await afterFrame();
    const tEnd = performance.now();
    const md = store.toMarkdown();
    const typed = keys.length;
    const injected = teammate.length;
    const xs = 'x'.repeat(typed);
    const ys = 'y'.repeat(injected);
    // The model learns the caret on the first key, not from the DOM range
    // alone; when it had none yet, the typed run itself says where it was.
    const caretFrom = caret >= 0 ? 'model' : 'typed run';
    if (caret < 0) caret = md.indexOf(xs);
    const yAt = md.length - 3 - injected;
    const rebuilt = md.slice(0, caret) + md.slice(caret + typed, yAt) + md.slice(yAt + injected);
    const check = {
      lengthOk: md.length === md0.length + typed + injected,
      typedInPlace: md.slice(caret, caret + typed) === xs,
      teammateInPlace: md.slice(yAt, yAt + injected) === ys,
      restUnchanged: rebuilt === md0,
    };
    check.ok = Object.values(check).every(Boolean);
    check.caret = caret;
    check.caretFrom = caretFrom;
    if (!check.ok) {
      const firstDiff = [...rebuilt].findIndex((c, i) => c !== md0[i]);
      check.detail = { typed, injected, caret, firstDiff, near: rebuilt.slice(Math.max(0, firstDiff - 40), firstDiff + 40), expected: md0.slice(Math.max(0, firstDiff - 40), firstDiff + 40) };
    }
    return {
      strictKeyMs: keys.map((k) => (k.painted ? k.painted - k.ts : null)),
      teammate,
      flushes: flushes.filter((f) => f.at >= tOpened).map(({ ms, by }) => ({ ms, by })),
      longestTask: Math.max(0, ...longtasks.filter((t) => t.start >= tOpened && t.start <= tEnd).map((t) => t.duration)),
      check,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
    };
  },
};
