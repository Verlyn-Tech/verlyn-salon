import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { buildLlm, ProviderChain } from "../src/llm/build.ts";
import { FreeModelRouter, groqProvider } from "../src/llm/freeModels.ts";
import { LLMUnavailableError } from "../src/llm/types.ts";
import { ScriptedLLM } from "./helpers.ts";

const OK = JSON.stringify({ choices: [{ message: { content: '{"answer":"hi"}' } }] });
const ask = { agent: "router" as const, system: "s", user: "u", schema: z.object({ answer: z.string() }) };

const GROQ_CATALOG = {
  data: [
    { id: "llama-3.3-70b-versatile", active: true, context_window: 128000 },
    { id: "openai/gpt-oss-120b", active: true, context_window: 128000 },
    { id: "openai/gpt-oss-20b", active: true, context_window: 128000 },
    { id: "llama-3.1-8b-instant", active: true, context_window: 128000 },
    { id: "whisper-large-v3", active: true, context_window: 448 },
    { id: "qwen/qwen3.8-27b", active: true, context_window: 128000 },
  ],
};
const OR_CATALOG = {
  data: [
    { id: "nvidia/a:free", context_length: 100000, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: [] },
    { id: "other/paid", context_length: 100000, pricing: { prompt: "0.001", completion: "0.001" }, architecture: { output_modalities: ["text"] }, supported_parameters: [] },
  ],
};

interface Call { host: string; model: string; auth: string | null; title: string | null }

function network(respond: (host: string, model: string) => Response) {
  const calls: Call[] = [];
  const catalogAuth: (string | null)[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = new Headers(init?.headers);
    if (u.pathname.endsWith("/models")) {
      if (u.host === "api.groq.com") catalogAuth.push(headers.get("authorization"));
      return new Response(JSON.stringify(u.host === "api.groq.com" ? GROQ_CATALOG : OR_CATALOG));
    }
    const model = JSON.parse(String(init?.body)).model as string;
    calls.push({ host: u.host, model, auth: headers.get("authorization"), title: headers.get("x-title") });
    return respond(u.host, model);
  }) as typeof fetch;
  return { calls, catalogAuth, fetchImpl };
}

const BOTH = { GROQ_API_KEY: "g-key", OPENROUTER_API_KEY: "o-key" };

test("Groq uses only its allowlisted production models", async () => {
  const net = network(() => new Response(OK));
  const models = await new FreeModelRouter({ apiKey: "g", provider: groqProvider(), fetchImpl: net.fetchImpl }).listFreeModels();
  assert.deepEqual(models.map((m) => m.id), ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant", "qwen/qwen3.8-27b"]);
  assert.equal(net.catalogAuth[0], "Bearer g");
});

test("Groq is first by default and each provider gets only its own key", async () => {
  const net = network(() => new Response(OK));
  const r = await buildLlm({ env: BOTH, fetchImpl: net.fetchImpl }).completeJson(ask);
  assert.match(r.model, /^groq:/);
  assert.equal(net.calls[0]?.host, "api.groq.com");
  assert.equal(net.calls[0]?.auth, "Bearer g-key");
  assert.equal(net.calls[0]?.title, null);
});

test("Normal traffic cycles the larger Groq models", async () => {
  const net = network(() => new Response(OK));
  const llm = buildLlm({ env: { GROQ_API_KEY: "g" }, fetchImpl: net.fetchImpl });
  await llm.completeJson(ask);
  await llm.completeJson(ask);
  assert.deepEqual(net.calls.map((c) => c.model), ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]);
});

test("A short Groq limit moves to OpenRouter straight away, with no wait", async () => {
  const net = network((host) => (host === "api.groq.com" ? new Response("{}", { status: 429, headers: { "retry-after": "5" } }) : new Response(OK)));
  const started = Date.now();
  const r = await buildLlm({ env: BOTH, fetchImpl: net.fetchImpl }).completeJson(ask);
  assert.equal(r.model, "nvidia/a:free");
  assert.ok(Date.now() - started < 2000, "must not sit out the 5 second limit");
});

test("A Groq 429 benches only that model", async () => {
  const net = network((_h, m) =>
    m === "llama-3.3-70b-versatile" ? new Response("{}", { status: 429, headers: { "retry-after": "600" } }) : new Response(OK),
  );
  const r = await buildLlm({ env: { GROQ_API_KEY: "g" }, fetchImpl: net.fetchImpl }).completeJson(ask);
  assert.equal(r.model, "groq:openai/gpt-oss-120b");
});

test("When every Groq model is out, OpenRouter's free models take over", async () => {
  const net = network((host) => (host === "api.groq.com" ? new Response("{}", { status: 429 }) : new Response(OK)));
  const failures: string[] = [];
  const r = await buildLlm({ env: BOTH, fetchImpl: net.fetchImpl, onFailover: (f) => failures.push(f.provider) }).completeJson(ask);
  assert.equal(r.model, "nvidia/a:free");
  assert.deepEqual(failures, ["groq"]);
  assert.ok(net.calls.filter((c) => c.host === "openrouter.ai").every((c) => c.model.endsWith(":free")));
});

test("A rejected Groq key falls through to OpenRouter", async () => {
  const net = network((host) => (host === "api.groq.com" ? new Response("{}", { status: 401 }) : new Response(OK)));
  assert.equal((await buildLlm({ env: BOTH, fetchImpl: net.fetchImpl }).completeJson(ask)).model, "nvidia/a:free");
});

test("LLM_PROVIDERS=groq never sends anything to OpenRouter, even in an outage", async () => {
  const net = network(() => new Response("x", { status: 500 }));
  const llm = buildLlm({ env: { ...BOTH, LLM_PROVIDERS: "groq" }, fetchImpl: net.fetchImpl });
  await assert.rejects(llm.completeJson(ask), LLMUnavailableError);
  assert.ok(net.calls.length > 0);
  assert.ok(net.calls.every((c) => c.host === "api.groq.com"));
});

test("LLM_PROVIDERS sets the order", async () => {
  const net = network(() => new Response(OK));
  await buildLlm({ env: { ...BOTH, LLM_PROVIDERS: "openrouter,groq" }, fetchImpl: net.fetchImpl }).completeJson(ask);
  assert.equal(net.calls[0]?.host, "openrouter.ai");
});

test("A model outside the allowlist can't be used through GROQ_MODELS mismatch", async () => {
  const net = network(() => new Response(OK));
  const llm = buildLlm({ env: { GROQ_API_KEY: "g", GROQ_MODELS: "not-in-groq-catalog" }, fetchImpl: net.fetchImpl });
  await assert.rejects(llm.completeJson(ask), (e: LLMUnavailableError) => e.reason === "no_free_models");
  assert.equal(net.calls.length, 0);
});

function clocked(respond: (attempt: number) => Response) {
  let t = 1_000_000;
  let attempt = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify(GROQ_CATALOG));
    return respond(++attempt);
  }) as typeof fetch;
  const router = new FreeModelRouter({
    apiKey: "g",
    provider: groqProvider(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]),
    fetchImpl,
    clock: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { router, sleeps, calls: () => attempt };
}

const limited = (seconds: number) => new Response("{}", { status: 429, headers: { "retry-after": String(seconds) } });

test("A short per-minute limit waits and retries instead of failing over", async () => {
  const h = clocked((n) => (n <= 2 ? limited(n === 1 ? 20 : 10) : new Response(OK)));
  const r = await h.router.completeJson(ask);
  assert.deepEqual(h.sleeps, [10_000]);
  assert.equal(r.model, "groq:openai/gpt-oss-20b");
  assert.equal(r.attempts, 3);
});

test("A long limit doesn't hold the customer up", async () => {
  const h = clocked(() => limited(3600));
  await assert.rejects(h.router.completeJson(ask), (e: LLMUnavailableError) => e.reason === "all_attempts_failed");
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.calls(), 2);
});

test("It only waits once per request", async () => {
  const h = clocked(() => limited(5));
  await assert.rejects(h.router.completeJson(ask));
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.calls(), 4);
});

test("Missing keys and typos give a clear error", () => {
  assert.throws(() => buildLlm({ env: {} }), /No API key found/);
  assert.throws(() => buildLlm({ env: { OPENROUTER_API_KEY: "o", LLM_PROVIDERS: "groq" } }), /No API key set for LLM_PROVIDERS=groq/);
  assert.throws(() => buildLlm({ env: { ...BOTH, LLM_PROVIDERS: "grok" } }), /Unknown LLM_PROVIDERS value: grok/);
});

test("Programming errors aren't hidden by failover", async () => {
  const chain = new ProviderChain([
    { name: "a", llm: new ScriptedLLM({ router: new TypeError("bug") }) },
    { name: "b", llm: new ScriptedLLM({ router: { answer: "hi" } }) },
  ]);
  await assert.rejects(chain.completeJson(ask), TypeError);
});

test("When all providers fail the orchestrator gets the standard error", async () => {
  const chain = new ProviderChain([
    { name: "a", llm: new ScriptedLLM({ router: new LLMUnavailableError("all_attempts_failed") }) },
    { name: "b", llm: new ScriptedLLM({ router: new LLMUnavailableError("free_quota_exhausted") }) },
  ]);
  await assert.rejects(chain.completeJson(ask), (e: LLMUnavailableError) => e.reason === "free_quota_exhausted");
});
