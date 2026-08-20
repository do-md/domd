export function commandKey(e: KeyboardEvent) {
    const isMac = /Mac/i.test(
        // @ts-expect-error
        navigator.userAgentData?.platform ||
        navigator.platform ||
        navigator.userAgent,
    );
    return isMac ? e.metaKey : e.ctrlKey;
}
