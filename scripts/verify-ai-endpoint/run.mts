/**
 * Custom AI endpoints — URL normalization plus the provider registry that
 * backs them (features/ai/lib/types.ts + lib/storage.ts on the web
 * localStorage backend).
 *
 * The two failure modes worth pinning down: a pasted base URL that resolves
 * to the wrong request URL (silent 404s from the user's proxy), and a
 * deleted endpoint that leaves its API key behind in config.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-ts-resolve.mjs \
 *        scripts/verify-ai-endpoint/run.mts
 */
let passed = 0;
const failures: string[] = [];

const check = (name: string, ok: boolean, detail = "") => {
    if (ok) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
};

// Minimal localStorage so the web backend of lib/storage.ts is live. Must be
// installed before the module is imported (it reads on first call only, but
// the stub also has to survive the whole run).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
        return store.size;
    },
} as Storage;

const { normalizeChatEndpoint, isCustomProvider, newCustomProviderId } =
    await import("../../features/ai/lib/types.ts");
const {
    loadProviders,
    upsertProvider,
    removeProvider,
    resolveEndpoint,
    providerLabel,
    loadApiKey,
    saveApiKey,
} = await import("../../features/ai/lib/storage.ts");

console.log("\nnormalizeChatEndpoint");
const CHAT = "/chat/completions";
check(
    "bare host gets /v1/chat/completions",
    normalizeChatEndpoint("https://api.deepseek.com") ===
        `https://api.deepseek.com/v1${CHAT}`,
);
check(
    "trailing slashes are stripped",
    normalizeChatEndpoint("https://api.deepseek.com///") ===
        `https://api.deepseek.com/v1${CHAT}`,
);
check(
    "surrounding whitespace is trimmed",
    normalizeChatEndpoint("  https://api.deepseek.com/v1  ") ===
        `https://api.deepseek.com/v1${CHAT}`,
);
check(
    "an OpenAI-style base URL only gets the path",
    normalizeChatEndpoint("https://proxy.example/v1") ===
        `https://proxy.example/v1${CHAT}`,
);
check(
    "a nested version segment counts as a base URL",
    normalizeChatEndpoint("https://gw.example/openai/v1") ===
        `https://gw.example/openai/v1${CHAT}`,
);
check(
    "v1beta counts as a version segment",
    normalizeChatEndpoint("https://gw.example/v1beta") ===
        `https://gw.example/v1beta${CHAT}`,
);
check(
    "a full chat-completions URL is left alone",
    normalizeChatEndpoint("https://gw.example/relay/chat/completions") ===
        "https://gw.example/relay/chat/completions",
);
check(
    "a path without a version segment is treated as a host",
    normalizeChatEndpoint("http://localhost:8080") ===
        `http://localhost:8080/v1${CHAT}`,
);
check("empty stays empty", normalizeChatEndpoint("   ") === "");

console.log("\nprovider ids");
const id = newCustomProviderId();
check("generated ids are custom", isCustomProvider(id));
check("built-in ids are not custom", !isCustomProvider("openai"));
check(
    "generated ids are unique",
    newCustomProviderId() !== newCustomProviderId(),
);

console.log("\nprovider registry (localStorage backend)");
check("no custom providers initially", loadProviders().length === 0);
check(
    "built-in endpoints resolve without config",
    resolveEndpoint("openai") === `https://api.openai.com/v1${CHAT}`,
);
check("built-in labels resolve", providerLabel("openrouter") === "OpenRouter");

upsertProvider({ id, label: "DeepSeek", baseUrl: "https://api.deepseek.com" });
saveApiKey(id, "sk-test");
check("upsert adds the provider", loadProviders().length === 1);
check(
    "custom endpoint resolves through normalization",
    resolveEndpoint(id) === `https://api.deepseek.com/v1${CHAT}`,
);
check("custom label resolves", providerLabel(id) === "DeepSeek");
check("custom key round-trips", loadApiKey(id) === "sk-test");

upsertProvider({ id, label: "DS", baseUrl: "https://proxy.local/v1" });
check("upsert updates in place", loadProviders().length === 1);
check(
    "updated base URL is what resolves",
    resolveEndpoint(id) === `https://proxy.local/v1${CHAT}`,
);
check("the key survives an endpoint edit", loadApiKey(id) === "sk-test");

const second = newCustomProviderId();
upsertProvider({ id: second, label: "Local", baseUrl: "http://127.0.0.1:1234" });
check(
    "a second endpoint appends rather than replaces",
    loadProviders().map((p) => p.id).join() === `${id},${second}`,
);

removeProvider(id);
check("remove drops the entry", loadProviders().map((p) => p.id).join() === second);
check("remove drops the key", loadApiKey(id) === "");
check("remove leaves other endpoints alone", resolveEndpoint(second) !== "");
check(
    "a dangling reference resolves to empty, not a bad URL",
    resolveEndpoint(id) === "",
);
check(
    "a dangling reference still has a diagnosable label",
    providerLabel(id) === id,
);

removeProvider("openai");
check(
    "built-in providers are not removable",
    resolveEndpoint("openai") === `https://api.openai.com/v1${CHAT}`,
);

console.log(
    `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failures.length} failed`,
);
if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
