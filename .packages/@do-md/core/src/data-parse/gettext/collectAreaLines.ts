/**
 * Lazy line scanner shared by the multi-line area extractors.
 *
 * The extractors used to open with `text.split("\n")` — on the WHOLE
 * remaining document — every time parseBlock probed an area. Each probe was
 * O(remaining), so a document with many areas parsed in O(n^2) (measured:
 * 2MB of list content took 10.3s, a 10MB mixed document took 50s). Scanning
 * line by line and stopping at the first "stop" keeps each probe O(area
 * consumed), which restores the linear parse the head-anchored top-level
 * loop is designed for.
 *
 * `decide` sees each line exactly as `split("\n")` would have produced it:
 * no trailing "\n" on the line, and a final empty line when the text ends
 * with "\n". It returns:
 *   - "push": the line belongs to the area;
 *   - "skip": not part of the area, keep scanning without collecting (the
 *     legacy pre-area prologue behavior — call sites guarantee line 0
 *     matches, so in practice this never walks past the area's start);
 *   - "stop": the area ended — stop scanning immediately. Lines after this
 *     point are never touched, which is where the O(n^2) went.
 */
export const collectAreaLines = (
    text: string,
    decide: (line: string) => "push" | "skip" | "stop",
): string[] => {
    const collected: string[] = [];
    let pos = 0;
    for (;;) {
        const newlineIndex = text.indexOf("\n", pos);
        const line =
            newlineIndex === -1
                ? pos === 0
                    ? text
                    : text.slice(pos)
                : text.slice(pos, newlineIndex);
        const action = decide(line);
        if (action === "stop") break;
        if (action === "push") collected.push(line);
        if (newlineIndex === -1) break;
        pos = newlineIndex + 1;
    }
    return collected;
};
