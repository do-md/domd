export interface DebouncedWithRAF {
  (...args: any[]): void;
  /** Disarm any scheduled invocation (timer + RAF). The next call re-arms
   *  normally. Lets callers make "invalidate pending work" atomic instead of
   *  relying on guards inside the callback. */
  cancel(): void;
}

export function debounceWithRAF(fn: (...args: any[]) => void, ms: number, immediate = false): DebouncedWithRAF {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let frame: number | undefined = undefined;

  const debounced = function (this: any, ...args: any[]) {
    const context = this;
    const callNow = immediate && !timer;

    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }

    clearTimeout(timer);

    timer = setTimeout(() => {
      timer = undefined;
      if (!immediate) {
        frame = requestAnimationFrame(() => {
          fn.apply(context, args);
          frame = undefined;
        });
      }
    }, ms);

    if (callNow) {
      frame = requestAnimationFrame(() => {
        fn.apply(context, args);
        frame = undefined;
      });
    }
  } as DebouncedWithRAF;

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  };

  return debounced;
}

