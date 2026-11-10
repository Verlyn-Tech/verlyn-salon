import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { handleInbound } from "../src/agents/orchestrator.ts";
import { ConsoleChannel, type Channel } from "../src/channels/types.ts";
import { openDb } from "../src/db.ts";
import { addSlot, confirmBooking, markEnteredElsewhere, notifyBookingConfirmed } from "../src/staff/operations.ts";
import { createStaffHandler } from "../src/staff/server.ts";
import { NOW, profile, ScriptedLLM } from "./helpers.ts";

const ROOT = "root_colour";
const bookingAnswer = (slot_id: unknown) => ({
  router: { intent: "booking", language: "en", confidence: 0.95 },
  booking: { reply: "The team will confirm shortly.", action: "request_new", service_id: null, preferred_time: null, needs_human: false, slot_id },
  guard: { pass: true, issues: [] },
});

function slotWorld() {
  const db = openDb();
  addSlot(db, profile, ROOT, "2026-11-08T15:00", "2026-11-08T17:00"); // id 1, tomorrow in Dubai
  addSlot(db, profile, ROOT, "2026-11-06T15:00", "2026-11-06T17:00"); // id 2, already past
  addSlot(db, profile, ROOT, "2026-12-30T15:00", "2026-12-30T17:00"); // id 3, too far ahead
  return db;
}

test("agents see real open slots, and a picked slot is saved for staff", async () => {
  const db = slotWorld();
  const llm = new ScriptedLLM(bookingAnswer("1"));
  await handleInbound({ db, profile, llm, channel: new ConsoleChannel(true), now: () => NOW }, { from: "+971500000001", text: "Tomorrow 3pm for roots please" });
  const prompt = llm.calls.find((c) => c.agent === "booking")!.system;
  assert.match(prompt, /2026-11-08T15:00/);
  assert.match(prompt, /Sunday 8 November at 15:00/, "code supplies the weekday");
  assert.doesNotMatch(prompt, /2026-11-06T15:00|2026-12-30T15:00/, "past and far-off slots aren't offered");
  const row = db.prepare("SELECT slot_id, service_id FROM booking_requests").get() as { slot_id: number; service_id: string };
  assert.equal(row.slot_id, 1);
  assert.equal(row.service_id, ROOT, "the slot's service fills in a missing one");
});

test("a slot the model invents isn't saved, and a held slot isn't offered again", async () => {
  const db = slotWorld();
  const run = (llm: ScriptedLLM, from: string) =>
    handleInbound({ db, profile, llm, channel: new ConsoleChannel(true), now: () => NOW }, { from, text: "Book me" });
  await run(new ScriptedLLM(bookingAnswer(99)), "+971500000001");
  assert.equal((db.prepare("SELECT slot_id FROM booking_requests").get() as { slot_id: number | null }).slot_id, null);
  await run(new ScriptedLLM(bookingAnswer(1)), "+971500000002");
  const third = new ScriptedLLM(bookingAnswer(1));
  await run(third, "+971500000003");
  assert.doesNotMatch(third.calls.find((c) => c.agent === "booking")!.system, /2026-11-08T15:00/);
  const last = db.prepare("SELECT slot_id FROM booking_requests ORDER BY id DESC LIMIT 1").get() as { slot_id: number | null };
  assert.equal(last.slot_id, null, "the second person can't grab the held slot");
});

function confirmedWorld(language = "en") {
  const db = openDb();
  db.prepare("INSERT INTO clients (id, first_name, phone, language, created_at) VALUES ('c', 'Mona', '+971500000001', ?, '2026-11-07')").run(language);
  db.prepare("INSERT INTO messages (client_id, direction, body, kind, at) VALUES ('c', 'in', 'hi', 'text', ?)").run(NOW.toISOString());
  db.prepare("INSERT INTO booking_requests (client_id, type, service_id, created_at) VALUES ('c', 'new', ?, '2026-11-07')").run(ROOT);
  addSlot(db, profile, ROOT, "2026-11-12T17:00", "2026-11-12T19:00");
  return { db, appointment: confirmBooking(db, 1, 1, NOW) };
}

test("confirming a booking messages the customer in their language", async () => {
  const en = confirmedWorld();
  const channel = new ConsoleChannel(true);
  assert.match(await notifyBookingConfirmed(en.db, channel, profile, en.appointment, NOW), /sent a confirmation/);
  assert.match(channel.sent[0]!.body, /Root colour at .* is confirmed for Thursday 12 November.* 17:00/);
  assert.equal((en.db.prepare("SELECT agent FROM messages ORDER BY id DESC LIMIT 1").get() as { agent: string }).agent, "booking_confirmation");
  assert.equal(en.db.prepare("SELECT 1 FROM handoffs").get(), undefined, "a confirmation doesn't take the chat away from the assistant");
  const ar = confirmedWorld("ar");
  const arChannel = new ConsoleChannel(true);
  await notifyBookingConfirmed(ar.db, arChannel, profile, ar.appointment, NOW);
  assert.match(arChannel.sent[0]!.body, /تم تأكيد موعد صبغة الجذور/);
});

test("the booking stands when the confirmation can't be sent", async () => {
  const whatsapp = (fail: boolean): Channel & { sent: number } => ({
    mode: "whatsapp",
    sent: 0,
    async sendText() {
      if (fail) throw new Error("Meta said no");
      this.sent++;
      return "wamid";
    },
    async sendTemplate() {
      return "wamid";
    },
  });
  const late = confirmedWorld();
  const closed = whatsapp(false);
  const dayLater = new Date(NOW.getTime() + 25 * 3_600_000);
  assert.match(await notifyBookingConfirmed(late.db, closed, profile, late.appointment, dayLater), /window is closed/);
  assert.equal(closed.sent, 0);
  const failing = confirmedWorld();
  assert.match(await notifyBookingConfirmed(failing.db, whatsapp(true), profile, failing.appointment, NOW), /couldn't be sent/);
  for (const { db } of [late, failing]) {
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n, 1);
  }
});

test("an appointment can be marked as entered in the booking system once", () => {
  const { db, appointment } = confirmedWorld();
  markEnteredElsewhere(db, appointment, NOW);
  const row = db.prepare("SELECT external_entered_at FROM appointments").get() as { external_entered_at: string };
  assert.equal(row.external_entered_at, NOW.toISOString());
  assert.throws(() => markEnteredElsewhere(db, appointment, NOW), /already marked/);
  assert.throws(() => markEnteredElsewhere(db, "x", NOW), /Invalid ID/);
});

test("existing database files get the new columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebook-migrate-"));
  const path = join(dir, "old.db");
  try {
    openDb(path).close();
    const db = openDb(path); // a second open must not try to add the columns again
    const columns = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns("booking_requests").includes("slot_id"));
    assert.ok(columns("appointments").includes("external_entered_at"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

async function dashboard(t: TestContext, password?: string) {
  const handler = createStaffHandler({ db: openDb(), profile, channel: new ConsoleChannel(true), ...(password ? { password } : {}) });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  return (headers: Record<string, string> = {}) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/state", headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
}

const basic = (password: string) => ({ Authorization: "Basic " + Buffer.from("staff:" + password).toString("base64") });

test("without a password the dashboard stays local-only", async (t) => {
  const get = await dashboard(t);
  assert.equal(await get(), 200);
  assert.equal(await get({ Host: "salon.example.com" }), 403);
});

test("with a password, staff can sign in through a tunnel and others can't", async (t) => {
  const password = "correct horse battery";
  const get = await dashboard(t, password);
  assert.equal(await get({ Host: "salon.example.com" }), 401);
  assert.equal(await get({ Host: "salon.example.com", ...basic("wrong password here") }), 401);
  assert.equal(await get({ Host: "salon.example.com", Authorization: "Basic !!!" }), 401);
  assert.equal(await get({ Host: "salon.example.com", ...basic(password) }), 200);
});

test("a short dashboard password is refused at startup", () => {
  assert.throws(() => createStaffHandler({ db: openDb(), profile, channel: new ConsoleChannel(true), password: "short" }), /at least 12/);
});
