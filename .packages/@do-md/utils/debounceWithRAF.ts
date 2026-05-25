export function debounceWithRAF(fn: (...args: any[]) => void, ms: number, immediate = false) {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let frame: number | undefined = undefined;

  return function (this: any, ...args: any[]) {
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
  };
}

