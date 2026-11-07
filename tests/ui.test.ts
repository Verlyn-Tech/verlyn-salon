import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createUiHandler, type UiOptions } from "../src/ui/server.ts";
import { profile } from "./helpers.ts";

async function start(t: TestContext, options: Partial<UiOptions> = {}) {
  const handler = createUiHandler({ profile, env: {}, ...options });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: object) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };
  return { base, post };
}

const SECRET = "super-secret-test-key";
const answerFor = (body: string): string => {
  if (body.includes("You route WhatsApp")) return '{"intent":"enquiry","language":"en","confidence":0.9}';
  if (body.includes("final safety reviewer")) return '{"pass":true,"issues":[]}';
  return '{"reply":"We open at 10:00.","needs_human":false,"handoff_reason":null}';
};
const fakeNetwork = (calls: string[]) =>
  (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(
        JSON.stringify(
          url.includes("groq")
            ? { data: [{ id: "openai/gpt-oss-120b", active: true, context_window: 128000 }] }
            : { data: [{ id: "nvidia/a:free", context_length: 100000, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: [] }] },
        ),
      );
    }
    calls.push(new URL(url).host);
    return new Response(JSON.stringify({ choices: [{ message: { content: answerFor(String(init?.body)) } }] }));
  }) as typeof fetch;

test("the page loads with a locked-down content policy", async (t) => {
  const { base } = await start(t);
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await res.text(), /Rebook test page/);
});

test("with no keys it starts in stub mode and shows the steps", async (t) => {
  const { post } = await start(t);
  const { status, data } = await post("/api/message", { text: "How much is a root colour?" });
  assert.equal(status, 200);
  assert.equal(data.state.mode, "stub");
  assert.equal(data.turn.stub, true);
  assert.equal(data.turn.outcome, "replied");
  assert.ok(data.turn.path.includes("guard_rules"));
  assert.equal(data.state.messages.length, 2);
});

test("a reaction goes to the staff queue, and closing it hands back", async (t) => {
  const { post } = await start(t);
  const first = await post("/api/message", { text: "I got a rash after my colour" });
  assert.equal(first.data.turn.outcome, "handoff");
  assert.equal(first.data.state.handoffs.length, 1);
  const quiet = await post("/api/message", { text: "hello?" });
  assert.equal(quiet.data.turn.outcome, "queued_for_staff");
  const closed = await post("/api/close-handoff", { id: first.data.state.handoffs[0].id });
  assert.equal(closed.data.handoffs.length, 0);
});

test("a lapsed client starts with the filled-in win-back template", async (t) => {
  const { post } = await start(t);
  const { data } = await post("/api/reset", { persona: "lapsed_en" });
  assert.equal(data.client.consent, "opted in");
  assert.equal(data.messages.length, 1);
  assert.match(data.messages[0].body, /Hi Mona, it's Noor Beauty Lounge\. Your Root colour/);
  assert.doesNotMatch(data.messages[0].body, /\{\{/);
});

test("the Arabic persona gets the Arabic template", async (t) => {
  const { post } = await start(t);
  const { data } = await post("/api/reset", { persona: "lapsed_ar" });
  assert.match(data.messages[0].body, /صبغة الجذور/);
});

test("STOP updates the consent shown on the page", async (t) => {
  const { post } = await start(t);
  await post("/api/reset", { persona: "regular_en" });
  const { data } = await post("/api/message", { text: "STOP" });
  assert.equal(data.state.client.consent, "opted out");
});

test("simulating a Groq limit moves to OpenRouter and the trace shows it", async (t) => {
  const calls: string[] = [];
  const env = { GROQ_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET };
  const { post } = await start(t, { env, fetchImpl: fakeNetwork(calls) });
  const normal = await post("/api/message", { text: "When do you open?" });
  assert.deepEqual([...new Set(calls)], ["api.groq.com"]);
  assert.deepEqual(normal.data.turn.failovers, []);

  calls.length = 0;
  await post("/api/settings", { simulateGroqLimit: true });
  await post("/api/reset", {});
  const limited = await post("/api/message", { text: "When do you open?" });
  assert.equal(limited.data.turn.outcome, "replied");
  assert.deepEqual([...new Set(calls)], ["openrouter.ai"]);
  assert.equal(limited.data.turn.failovers[0].provider, "groq");
  assert.ok(limited.data.turn.attempts.some((a: { outcome: string }) => a.outcome === "model_rate_limited"));

  calls.length = 0;
  await post("/api/settings", { simulateGroqLimit: false });
  await post("/api/reset", {});
  await post("/api/message", { text: "When do you open?" });
  assert.deepEqual([...new Set(calls)], ["api.groq.com"], "Groq is back as soon as the switch is off");
});

test("Groq only never calls OpenRouter, and the customer goes to staff", async (t) => {
  const calls: string[] = [];
  const { post } = await start(t, { env: { GROQ_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET, LLM_PROVIDERS: "groq" }, fetchImpl: fakeNetwork(calls) });
  await post("/api/settings", { simulateGroqLimit: true, mode: "groq" });
  const { data } = await post("/api/message", { text: "When do you open?" });
  assert.equal(data.turn.outcome, "handoff");
  assert.ok(!calls.includes("openrouter.ai"));
});

test("API keys never appear in anything the page receives", async (t) => {
  const { base, post } = await start(t, { env: { GROQ_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET }, fetchImpl: fakeNetwork([]) });
  const state = await (await fetch(`${base}/api/state`)).text();
  const turn = JSON.stringify((await post("/api/message", { text: "When do you open?" })).data);
  assert.ok(!state.includes(SECRET));
  assert.ok(!turn.includes(SECRET));
  assert.equal(JSON.parse(state).keys.groq, true);
});

test("the trace shows identifiers removed before the models see them", async (t) => {
  const { post } = await start(t);
  await post("/api/reset", { persona: "regular_en" });
  const { data } = await post("/api/message", { text: "It's Mona, my number is 050 111 1111, how much is a root colour?" });
  assert.match(data.turn.modelSaw, /\{\{first_name\}\}/);
  assert.match(data.turn.modelSaw, /\[phone\]/);
  assert.doesNotMatch(data.turn.modelSaw, /Mona|111 1111/);
});

test("requests from another site are refused", async (t) => {
  const { base } = await start(t);
  const form = await fetch(`${base}/api/message`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"text":"hi"}' });
  assert.equal(form.status, 415);
  const { request } = await import("node:http");
  const url = new URL(base);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: "/api/state", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("bad input gets a clear error", async (t) => {
  const { post } = await start(t);
  assert.equal((await post("/api/message", { text: "   " })).status, 400);
  assert.equal((await post("/api/reset", { persona: "nope" })).status, 400);
  assert.equal((await post("/api/settings", { mode: "paid-model" })).status, 400);
  assert.equal((await post("/api/nowhere", {})).status, 404);
});

test("the staff dashboard shares the test chat, pricing and reply history", async (t) => {
  const { base, post } = await start(t);
  assert.equal((await fetch(base + "/staff/")).status, 200);
  await post("/api/message", { text: "How much is a root colour?" });
  const state = await (await fetch(base + "/staff/api/state")).json() as any;
  assert.equal(state.conversations.length, 1);
  const reply = await post("/staff/api/reply", { clientId: state.conversations[0].id, text: "Hello from reception" });
  assert.equal(reply.status, 200);
  const chat = await (await fetch(base + "/api/state")).json() as any;
  assert.equal(chat.messages.at(-1).agent, "staff");
  assert.equal(chat.messages.at(-1).body, "Hello from reception");
  assert.equal((await post("/api/message", { text: "Hello again" })).data.turn.outcome, "queued_for_staff");
  const price = await post("/staff/api/price", { serviceId: profile.services[0]!.id, price: 199.99 });
  assert.equal(price.data.services[0].price_aed, 199.99);
});
