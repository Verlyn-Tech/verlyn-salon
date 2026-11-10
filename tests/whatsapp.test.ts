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
import { createStaffHandler } from "../src/staff/server.ts";
import { StubLLM } from "../src/llm/stub.ts";

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

test("credential checking reads the account without sending or putting the token in the URL", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const channel = new WhatsAppChannel({ token: "private-test-token", phoneNumberId: "123", graphVersion: "v23.0",
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "123", display_phone_number: "+971500000001", verified_name: "Test salon" }));
    }) as typeof fetch,
  });
  assert.equal((await channel.checkConnection()).id, "123");
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.url.includes("private-test-token"));
  assert.ok(!calls[0]!.url.includes("/messages"));
  assert.equal(calls[0]!.init?.body, undefined);
});

test("only the configured business phone number is processed and original timestamps are kept", () => {
  const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" }, messages: [
    { from: "971500000001", id: "m1", type: "text", text: { body: "hi" }, timestamp: "1794038400" },
  ] } }] }] };
  assert.equal(parseWebhook(body, "999").length, 0);
  assert.equal(parseWebhook(body, "123")[0]?.sentAt, new Date(1794038400 * 1000).toISOString());
  assert.equal(verifySignature(Buffer.from("hello"), sign("hello") + "garbage", SECRET), false);
});

async function integrated(t: TestContext) {
  const db = openDb();
  const sent: any[] = [];
  const network = { fail: false };
  const channel = new WhatsAppChannel({ token: "private-test-token", phoneNumberId: "123", graphVersion: "v23.0",
    fetchImpl: (async (_url, init) => {
      if (network.fail) return new Response(JSON.stringify({ error: { code: 190, message: "private-test-token" } }), { status: 401 });
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
    }) as typeof fetch,
  });
  const webhook = createWebhookHandler({ db, profile, channel, llm: new StubLLM(), now: () => new Date() }, {
    verifyToken: "verify-me", appSecret: SECRET, phoneNumberId: "123",
  });
  const staff = createStaffHandler({ db, profile, channel, basePath: "/staff", runExclusive: webhook.runExclusive });
  const server = createServer((req, res) => void (req.url?.startsWith("/staff") ? staff(req, res) : webhook(req, res)));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await webhook.idle(); await new Promise<void>(r => server.close(() => r())); db.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const receive = async (id: string, text: string) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" }, messages: [
      { from: "971501112222", id, type: "text", text: { body: text } },
    ] } }] }] });
    const response = await fetch(base + "/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } });
    assert.equal(response.status, 200);
    await webhook.idle();
  };
  const post = (path: string, body: object) => fetch(base + "/staff/api/" + path, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });
  return { db, sent, network, base, receive, post, webhook };
}

test("signed WhatsApp messages and real-channel staff replies share one inbox and preserve handoff ownership", async t => {
  const { db, sent, base, receive, post } = await integrated(t);
  await receive("customer-1", "I got a rash after my colour");
  const state = await (await fetch(base + "/staff/api/state")).json() as any;
  assert.equal(state.channel, "whatsapp");
  assert.equal(state.conversations.length, 1);
  const clientId = state.conversations[0].id;
  const reply = await post("reply", { clientId, text: "Reception here, I can help." });
  assert.equal(reply.status, 200);
  assert.equal(sent.at(-1).to, "971501112222");
  assert.equal(sent.at(-1).text.body, "Reception here, I can help.");
  const count = sent.length;
  await receive("customer-2", "Thanks");
  assert.equal(sent.length, count);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent = 'staff'").get()?.n, 1);
});

test("expired reply windows and Meta send failures cannot create a falsely sent staff reply", async t => {
  const { db, sent, network, receive, post } = await integrated(t);
  await receive("customer-1", "I need a refund");
  const clientId = String(db.prepare("SELECT id FROM clients LIMIT 1").get()!.id);
  const count = sent.length;
  db.prepare("UPDATE messages SET at = ? WHERE direction = 'in'").run(new Date(Date.now() - 25 * 3600_000).toISOString());
  assert.equal((await post("reply", { clientId, text: "Hello" })).status, 409);
  assert.equal(sent.length, count);
  db.prepare("UPDATE messages SET at = ? WHERE direction = 'in'").run(new Date().toISOString());
  network.fail = true;
  const failed = await post("reply", { clientId, text: "Hello" });
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes("private-test-token"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent = 'staff'").get()?.n, 0);
});

test("staff sending waits for the active inbound turn", async t => {
  const { db, sent, receive, post, webhook } = await integrated(t);
  await receive("customer-1", "I need a refund");
  const clientId = String(db.prepare("SELECT id FROM clients LIMIT 1").get()!.id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = webhook.runExclusive(() => gate);
  const response = post("reply", { clientId, text: "A reply after the current turn" });
  const count = sent.length;
  assert.equal(sent.length, count);
  release();
  await active;
  assert.equal((await response).status, 200);
  assert.equal(sent.at(-1).text.body, "A reply after the current turn");
});
