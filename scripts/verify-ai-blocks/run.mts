/**
 * Streaming-parser verification for plugins/ai-collab/edit-blocks.ts.
 * Every case runs under the HARSHEST chunking (1 char per push) plus a few
 * random chunkings — the marker-split-across-chunks class of bug only
 * shows up under adversarial chunk boundaries.
 *
 *   node --experimental-strip-types scripts/verify-ai-blocks/run.mts
 */
import {
    EditStreamParser,
    type EditStreamEvent,
} from "../../plugins/ai-collab/edit-blocks.ts";

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) passed += 1;
    else {
        failed += 1;
        console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    }
};

/** Feed `text` in fixed-size chunks and collect all events. */
const run = (text: string, chunkSize: number): EditStreamEvent[] => {
    const parser = new EditStreamParser();
    const events: EditStreamEvent[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        events.push(...parser.push(text.slice(i, i + chunkSize)));
    }
    events.push(...parser.finish());
    return events;
};

/** Aggregate a run into a comparable summary. */
const summarize = (events: EditStreamEvent[]) => {
    const searches: string[] = [];
    const replaces: string[] = [];
    let current = "";
    let blockEnds = 0;
    let malformed = 0;
    let content = "";
    let mode = "";
    for (const e of events) {
        if (e.kind === "mode") mode = e.mode;
        else if (e.kind === "search") {
            searches.push(e.search);
            current = "";
        } else if (e.kind === "replace") current += e.text;
        else if (e.kind === "block-end") {
            replaces.push(current);
            current = "";
            blockEnds += 1;
        } else if (e.kind === "malformed") malformed += 1;
        else if (e.kind === "content") content += e.text;
    }
    return { mode, searches, replaces, blockEnds, malformed, content };
};

const CHUNKS = [1, 3, 7, 1000];
const forAllChunks = (
    name: string,
    text: string,
    assert: (s: ReturnType<typeof summarize>, label: string) => void,
) => {
    for (const size of CHUNKS) {
        assert(summarize(run(text, size)), `${name} [chunk=${size}]`);
    }
};

// 1. Well-formed block (7-char markers).
forAllChunks(
    "well-formed",
    "<<<<<<< SEARCH\nold line one\nold line two\n=======\nnew line\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} mode`, s.mode === "edits");
        check(`${n} search`, s.searches[0] === "old line one\nold line two", JSON.stringify(s.searches));
        check(`${n} replace`, s.replaces[0] === "new line", JSON.stringify(s.replaces));
        check(`${n} ends`, s.blockEnds === 1 && s.malformed === 0);
    },
);

// 2. FIVE-char closing marker split across chunks (today's field bug).
forAllChunks(
    "5-char close",
    "<<<<<<< SEARCH\nalpha\n=======\nbeta\n>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} replace clean`, s.replaces[0] === "beta", JSON.stringify(s.replaces));
        check(`${n} no marker leak`, !s.replaces.join("").includes("REPLACE"));
        check(`${n} ends`, s.blockEnds === 1);
    },
);

// 3. Malformed: divider missing (the user's gpt-4o-mini stream shape).
forAllChunks(
    "missing divider",
    "<<<<<<< SEARCH\noriginal english\n>>>>>>> REPLACE\nchinese text\n",
    (s, n) => {
        check(`${n} malformed reported`, s.malformed === 1, `malformed=${s.malformed}`);
        check(`${n} nothing applied`, s.blockEnds === 0 && s.replaces.length === 0);
    },
);

// 4. Empty REPLACE (explicit deletion).
forAllChunks(
    "empty replace",
    "<<<<<<< SEARCH\ndoomed\n=======\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} one end`, s.blockEnds === 1 && s.malformed === 0);
        check(`${n} empty`, s.replaces[0] === "", JSON.stringify(s.replaces));
    },
);

// 5. Aider divider-terminated variant: ======= closes block 1 AND opens
// block 2's SEARCH directly.
forAllChunks(
    "divider variant",
    "<<<<<<< SEARCH\na\n=======\nA\n=======\nb\n=======\nB\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} two searches`, s.searches.length === 2 && s.searches[0] === "a" && s.searches[1] === "b", JSON.stringify(s.searches));
        check(`${n} two replaces`, s.replaces.length === 2 && s.replaces[0] === "A" && s.replaces[1] === "B", JSON.stringify(s.replaces));
    },
);

// 6. Content line whose TAIL looks like a divider must not terminate
// (mid-line remainder protection).
forAllChunks(
    "midline fake marker",
    "<<<<<<< SEARCH\nx\n=======\nresult: =======\ndone\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} replace intact`, s.replaces[0] === "result: =======\ndone", JSON.stringify(s.replaces));
        check(`${n} one end`, s.blockEnds === 1);
    },
);

// 7. Quoted markdown lines ("> ...") survive as content.
forAllChunks(
    "quote lines",
    "<<<<<<< SEARCH\nx\n=======\n> quoted line\n> another\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} quotes kept`, s.replaces[0] === "> quoted line\n> another", JSON.stringify(s.replaces));
    },
);

// 8. Content mode (no blocks).
forAllChunks("content mode", "Hello **world**, plain reply.", (s, n) => {
    check(`${n} mode`, s.mode === "content");
    check(`${n} text`, s.content === "Hello **world**, plain reply.", JSON.stringify(s.content));
});

// 9. Unclosed block with REPLACE text -> malformed, never applied
// (aider semantics: an unterminated block is rejected wholesale).
forAllChunks(
    "unclosed block rejected",
    "<<<<<<< SEARCH\nx\n=======\ntyped already",
    (s, n) => {
        check(`${n} no end`, s.blockEnds === 0, `ends=${s.blockEnds}`);
        check(`${n} malformed`, s.malformed === 1, `malformed=${s.malformed}`);
    },
);

// 10. Unclosed block with EMPTY replace -> malformed, never a deletion.
forAllChunks(
    "unclosed empty replace",
    "<<<<<<< SEARCH\nx\n=======\n",
    (s, n) => {
        check(`${n} no end`, s.blockEnds === 0);
        check(`${n} malformed`, s.malformed === 1);
    },
);

// 11. Two consecutive well-formed blocks.
forAllChunks(
    "two blocks",
    "<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} both`, s.blockEnds === 2 && s.replaces[0] === "A" && s.replaces[1] === "B", JSON.stringify(s.replaces));
    },
);

// 12. Multi-line replace keeps internal newlines, no trailing newline.
forAllChunks(
    "multiline replace",
    "<<<<<<< SEARCH\nx\n=======\nline one\n\nline three\n>>>>>>> REPLACE\n",
    (s, n) => {
        check(`${n} newlines`, s.replaces[0] === "line one\n\nline three", JSON.stringify(s.replaces));
    },
);

// 13. Chatter around blocks (mode preset from whole-reply scan — aider
// scans entire replies; chatter must be ignored, not inserted).
{
    const reply =
        "Here are the changes you asked for:\n\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n\nLet me know if you need more!\n";
    const { replyHasBlocks } = await import(
        "../../plugins/ai-collab/edit-blocks.ts"
    );
    check("chatter detect", replyHasBlocks(reply) === true);
    const parser = new EditStreamParser("edits");
    const s = summarize([...parser.push(reply), ...parser.finish()]);
    check("chatter ignored", s.blockEnds === 1 && s.replaces[0] === "new" && s.malformed === 0, JSON.stringify(s));
    check("chatter no content", s.content === "");
}

// Random chunking fuzz over a composite stream.
const composite =
    "<<<<<<< SEARCH\nfirst target\n=======\nFIRST NEW\n>>>>>>> REPLACE\n" +
    "<<<<<<< SEARCH\nsecond target\n=======\n> quote\nresult: =======\n>>>>> REPLACE\n";
let fuzzOk = true;
for (let round = 0; round < 200; round += 1) {
    const parser = new EditStreamParser();
    const events: EditStreamEvent[] = [];
    let i = 0;
    // Deterministic pseudo-random chunk sizes (no Math.random dependence on env).
    let seed = round * 2654435761 + 1;
    const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return (seed % 6) + 1;
    };
    while (i < composite.length) {
        const size = next();
        events.push(...parser.push(composite.slice(i, i + size)));
        i += size;
    }
    events.push(...parser.finish());
    const s = summarize(events);
    if (
        s.blockEnds !== 2 ||
        s.replaces[0] !== "FIRST NEW" ||
        s.replaces[1] !== "> quote\nresult: =======" ||
        s.malformed !== 0
    ) {
        fuzzOk = false;
        console.error(`FUZZ FAIL round=${round}`, JSON.stringify(s));
        break;
    }
}
check("fuzz 200 rounds", fuzzOk);

console.log(`verify-ai-blocks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
