import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConsoleChannel } from "../src/channels/types.ts";
import { openDb } from "../src/db.ts";
import { handleInbound } from "../src/agents/orchestrator.ts";
import { StubLLM } from "../src/llm/stub.ts";
import { addSlot, confirmBooking, effectiveProfile, sendStaffReply, setPrice } from "../src/staff/operations.ts";
import { profile } from "./helpers.ts";

test("staff replies take ownership and the assistant waits", async () => {
  const db = openDb();
  try {
    const channel = new ConsoleChannel(true);
    const deps = { db, profile, channel, llm: new StubLLM(), now: () => new Date() };
    await handleInbound(deps, { from: "+971500000001", text: "How much is a root colour?" });
    const client = db.prepare("SELECT id FROM clients LIMIT 1").get() as { id: string };
    await sendStaffReply(db, channel, client.id, "Hi, Mona here from reception.");
    assert.equal(channel.sent.at(-1)?.body, "Hi, Mona here from reception.");
    const count = channel.sent.length;
    const result = await handleInbound(deps, { from: "+971500000001", text: "Thanks, can you help?" });
    assert.equal(result.outcome, "queued_for_staff");
    assert.equal(channel.sent.length, count);
    assert.equal(db.prepare("SELECT agent FROM messages ORDER BY id DESC LIMIT 1 OFFSET 1").get()?.agent, "staff");
  } finally { db.close(); }
});

test("a booking consumes its slot exactly once and mismatches do not change data", () => {
  const db = openDb();
  try {
    db.prepare("INSERT INTO clients (id, phone, created_at) VALUES ('c', '+971500000001', '2026-11-07')").run();
    db.prepare("INSERT INTO booking_requests (client_id, type, service_id, created_at) VALUES ('c', 'new', ?, '2026-11-07')").run(profile.services[0]!.id);
    addSlot(db, profile, profile.services[0]!.id, "2026-11-09T14:00", "2026-11-09T18:00");
    confirmBooking(db, 1, 1);
    assert.equal(db.prepare("SELECT status FROM availability_slots WHERE id = 1").get()?.status, "booked");
    assert.equal(db.prepare("SELECT status FROM booking_requests WHERE id = 1").get()?.status, "done");
    assert.throws(() => confirmBooking(db, 1, 1));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM appointments").get()?.n, 1);
    db.prepare("INSERT INTO booking_requests (client_id, type, service_id, created_at) VALUES ('c', 'new', ?, '2026-11-07')").run(profile.services[1]!.id);
    addSlot(db, profile, profile.services[0]!.id, "2026-11-10T14:00", "2026-11-10T18:00");
    assert.throws(() => confirmBooking(db, 2, 2), /does not match/);
    assert.equal(db.prepare("SELECT status FROM availability_slots WHERE id = 2").get()?.status, "available");
    assert.equal(db.prepare("SELECT status FROM booking_requests WHERE id = 2").get()?.status, "pending");
  } finally { db.close(); }
});

test("prices and availability survive reopening the backend database", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebook-staff-"));
  const path = join(dir, "test.db");
  try {
    const first = openDb(path);
    setPrice(first, profile, profile.services[0]!.id, 199.99);
    addSlot(first, profile, profile.services[0]!.id, "2026-11-09T14:00", "2026-11-09T18:00");
    first.close();
    const reopened = openDb(path);
    assert.equal(effectiveProfile(reopened, profile).services[0]!.price_aed, 199.99);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM availability_slots").get()?.n, 1);
    assert.notEqual(profile.services[0]!.price_aed, 199.99);
    assert.throws(() => setPrice(reopened, profile, profile.services[0]!.id, null));
    assert.throws(() => addSlot(reopened, profile, profile.services[0]!.id, "2026-02-30T14:00", "2026-02-30T18:00"));
    reopened.close();
  } finally { rmSync(dir, { recursive: true }); }
});
