export function debounce<T extends (...args: any[]) => any>(
    fn: T,
    ms: number,
    immediate = false,
): (...args: Parameters<T>) => void {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    return function (this: any, ...args: Parameters<T>) {
        const context = this;
        const callNow = immediate && !timer;

        clearTimeout(timer);

        timer = setTimeout(() => {
            timer = undefined;
            if (!immediate) {
                fn.apply(context, args);
            }
        }, ms);

        if (callNow) {
            fn.apply(context, args);
        }
    };
}
