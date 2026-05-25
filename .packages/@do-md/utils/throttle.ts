export function throttle(fn: (...args: any[]) => void, ms: number, skipFirst = false): (...args: any[]) => void {
  let lastTime = 0;
  let skippedFirst = !skipFirst;

  return function (this: any, ...args: any[]) {
    const context = this;
    const now = Date.now();

    if (skipFirst && !skippedFirst) {
      skippedFirst = true;
      return;
    }

    if (now - lastTime >= ms) {
      lastTime = now;
      fn.apply(context, args);
    }
  };
}

// Test modification 1767541584
