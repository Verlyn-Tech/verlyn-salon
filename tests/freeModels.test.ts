import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { extractJson, FreeModelRouter, selectFreeModels } from "../src/llm/freeModels.ts";
import { LLMUnavailableError } from "../src/llm/types.ts";

const model = (id: string, prompt = "0", completion = "0", extra: object = {}) => ({
  id,
  context_length: 100000,
  pricing: { prompt, completion },
  architecture: { output_modalities: ["text"] },
  supported_parameters: [],
  ...extra,
});

const CATALOG = [
  model("nvidia/a:free"),
  model("nvidia/b:free"),
  model("other/c:free"),
  model("other/paid", "0.000001", "0.000002"),
  model("nvidia/sneaky:free", "0.000001", "0"),
  model("openrouter/free"),
  model("other/embed:free", "0", "0", { architecture: { output_modalities: ["embeddings"] } }),
];

const OK = JSON.stringify({ choices: [{ message: { content: '{"answer":"hi"}' } }] });

type Respond = (model: string) => Response;

function harness(respond: Respond, options: object = {}) {
  const calls: string[] = [];
  let t = 1_000_000;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: CATALOG }));
    const id = JSON.parse(String(init?.body)).model as string;
    calls.push(id);
    return respond(id);
  }) as typeof fetch;
  const router = new FreeModelRouter({
    apiKey: "test",
    preferredPrefixes: ["nvidia/"],
    fetchImpl,
    clock: () => t,
    ...options,
  });
  const ask = () => router.completeJson({ agent: "router", system: "s", user: "u", schema: z.object({ answer: z.string() }) });
  return { calls, router, ask, advance: (ms: number) => (t += ms) };
}

test("only genuinely free text models are selected", () => {
  const ids = selectFreeModels(CATALOG).map((m) => m.id);
  assert.deepEqual(ids.sort(), ["nvidia/a:free", "nvidia/b:free", "other/c:free"]);
});

test("paid models are never called, even when every free model fails", async () => {
  const h = harness(() => new Response("boom", { status: 500 }));
  await assert.rejects(h.ask(), LLMUnavailableError);
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every((id) => id.endsWith(":free")));
});

test("requests cycle through the free models", async () => {
  const h = harness(() => new Response(OK));
  await h.ask();
  await h.ask();
  await h.ask();
  assert.deepEqual(h.calls, ["nvidia/a:free", "nvidia/b:free", "nvidia/a:free"]);
});

test("a rate-limited model is skipped and the request moves on", async () => {
  const h = harness((id) => (id === "nvidia/a:free" ? new Response("{}", { status: 429 }) : new Response(OK)));
  const r = await h.ask();
  assert.equal(r.model, "nvidia/b:free");
  assert.equal(r.attempts, 2);
});

test("preferred models fail over to other free models", async () => {
  const h = harness((id) => (id.startsWith("nvidia/") ? new Response("x", { status: 503 }) : new Response(OK)));
  assert.equal((await h.ask()).model, "other/c:free");
});

test("a benched model comes back after its cooldown", async () => {
  let down = true;
  const h = harness((id) => (id === "nvidia/a:free" && down ? new Response("x", { status: 503 }) : new Response(OK)));
  await h.ask();
  h.calls.length = 0;
  await h.ask();
  await h.ask();
  assert.ok(!h.calls.includes("nvidia/a:free"));
  down = false;
  h.advance(3 * 60_000);
  h.calls.length = 0;
  await h.ask();
  await h.ask();
  assert.ok(h.calls.includes("nvidia/a:free"));
});

test("hitting the account-wide free cap stops cycling and pauses until reset", async () => {
  const reset = 1_000_000 + 3_600_000;
  const h = harness(
    () => new Response("{}", { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }),
  );
  await assert.rejects(h.ask(), (e: LLMUnavailableError) => e.reason === "free_quota_exhausted");
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.ask(), (e: LLMUnavailableError) => e.reason === "free_quota_exhausted");
  assert.equal(h.calls.length, 1, "no requests are spent while paused");
});

test("invalid JSON or a schema mismatch moves to the next model", async () => {
  const h = harness((id) =>
    id === "nvidia/a:free"
      ? new Response(JSON.stringify({ choices: [{ message: { content: '{"wrong":1}' } }] }))
      : new Response(OK),
  );
  assert.equal((await h.ask()).model, "nvidia/b:free");
});

test("a 200 response carrying an error is treated as a failure", async () => {
  const h = harness((id) =>
    id === "nvidia/a:free" ? new Response(JSON.stringify({ error: { message: "upstream" } })) : new Response(OK),
  );
  assert.equal((await h.ask()).model, "nvidia/b:free");
});

test("a bad API key fails immediately instead of cycling", async () => {
  const h = harness(() => new Response("{}", { status: 401 }));
  await assert.rejects(h.ask(), (e: LLMUnavailableError) => e.reason === "auth_failed");
  assert.equal(h.calls.length, 1);
});

test("attempts per request are capped", async () => {
  const h = harness(() => new Response("x", { status: 500 }), { maxAttempts: 2 });
  await assert.rejects(h.ask());
  assert.equal(h.calls.length, 2);
});

test("JSON is extracted from fences and reasoning tags", () => {
  assert.deepEqual(extractJson('<think>hmm {x}</think>\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJson("no json here"));
});
