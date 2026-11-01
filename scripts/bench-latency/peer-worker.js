// The teammate for config C, in a worker so its work is off the measured
// thread (in real use it is on another machine). A headless store seeded
// from the page's tree; it applies the page's ops in order, and on 'edit'
// types 'y' three characters before the end and sends back its ops.
import { EditorStore } from '@do-md/core-react';

let store = null;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    if (data.type === 'init') {
      store = new EditorStore({ editable: true, initMd: '' });
      store.applyExternalRenderData(data.snapshot);
      self.postMessage({ type: 'ready', chars: store.toMarkdown().length });
    } else if (data.type === 'ops') {
      await store.applyExternalRenderDataOps(data.ops);
    } else if (data.type === 'edit') {
      let ops = null;
      const off = store.subscribeRenderDataOps((o) => { ops = o; });
      const at = store.toMarkdown().length - 3;
      const result = store.replaceRanges({ start: at, end: at, text: 'y' });
      off();
      self.postMessage({ type: 'edited', ops: ops ?? [], applied: result.applied, failed: result.failed });
    }
  });
};
