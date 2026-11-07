import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createWebhookHandler } from "../src/channels/server.ts";
import { ConsoleChannel } from "../src/channels/types.ts";
import { parseWebhook, verifySignature, WhatsAppChannel } from "../src/channels/whatsapp.ts";
import { openDb } from "../src/db.ts";
import { NOW, profile, ScriptedLLM } from "./helpers.ts";

const SECRET = "app-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const payload = (id: string, text: string) =>
  JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "971501112222", id, type: "text", text: { body: text } }] } }] }] });

async function start(t: TestContext) {
  const db = openDb();
  const channel = new ConsoleChannel(true);
  const handler = createWebhookHandler(
    { db, profile, channel, llm: new ScriptedLLM({}), now: () => NOW },
    { verifyToken: "verify-me", appSecret: SECRET },
  );
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, channel, handler, base };
}

test("signature check rejects tampered or unsigned bodies", () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, sign('{"a":1}'), SECRET), true);
  assert.equal(verifySignature(body, sign('{"a":2}'), SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, "sha256=abc", SECRET), false);
});

test("webhook parsing handles text, media and delivery receipts", () => {
  const media = { entry: [{ changes: [{ value: { messages: [{ from: "971501112222", id: "m2", type: "audio" }] } }] }] };
  const receipt = { entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] };
  assert.equal(parseWebhook(JSON.parse(payload("m1", "hi")))[0]?.from, "+971501112222");
  assert.equal(parseWebhook(media)[0]?.kind, "other");
  assert.deepEqual(parseWebhook(receipt), []);
  assert.deepEqual(parseWebhook({ junk: true }), []);
});

test("Meta's verification handshake needs the right token", async (t) => {
  const { base } = await start(t);
  const good = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "42");
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test("an unsigned POST is rejected and nothing is processed", async (t) => {
  const { base, db } = await start(t);
  const res = await fetch(`${base}/webhook`, { method: "POST", body: payload("m1", "STOP") });
  assert.equal(res.status, 401);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("a signed POST is processed, and a retry from Meta is ignored", async (t) => {
  const { base, handler, channel } = await start(t);
  const body = payload("m1", "STOP");
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${base}/webhook`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } });
    assert.equal(res.status, 200);
  }
  await handler.idle();
  assert.equal(channel.sent.length, 1);
});

test("WhatsApp send payloads match the Cloud API shape", async () => {
  const bodies: Record<string, unknown>[] = [];
  const channel = new WhatsAppChannel({
    token: "t",
    phoneNumberId: "123",
    graphVersion: "v23.0",
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }));
    }) as typeof fetch,
  });
  assert.equal(await channel.sendTemplate("+971501112222", "tpl", "en", ["A", "B"]), "wamid.1");
  await channel.sendText("+971501112222", "hello");
  assert.deepEqual(bodies[0], {
    messaging_product: "whatsapp",
    to: "971501112222",
    type: "template",
    template: { name: "tpl", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }] },
  });
  assert.equal((bodies[1] as { type: string }).type, "text");
});

test("live sending refuses to start without credentials", () => {
  assert.throws(() => new WhatsAppChannel({ token: "", phoneNumberId: "", graphVersion: "v23.0" }));
});
