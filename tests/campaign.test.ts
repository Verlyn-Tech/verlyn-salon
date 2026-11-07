import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleChannel } from "../src/channels/types.ts";
import { openDb, type DB } from "../src/db.ts";
import { importClients, importVisits } from "../src/import/csv.ts";
import { analyzeClient } from "../src/retention/overdue.ts";
import { buildCampaign, sendCampaign } from "../src/retention/campaign.ts";
import { CLIENT_HEADER, NOW, profile, VISIT_HEADER } from "./helpers.ts";

const visit = (service: string, visited_at: string, status = "completed") => ({ service, visited_at, status });

function seedOverdue(db: DB, count: number, consent = "yes") {
  let clients = CLIENT_HEADER;
  let visits = VISIT_HEADER;
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(4, "0");
    clients += `c${n},Client${n},050000${n},en,${consent},qr\n`;
    visits += `c${n},Root colour,2026-06-01,280,completed\n`;
  }
  importClients(db, clients, NOW);
  importVisits(db, visits, NOW);
}

test("a client's own rhythm beats the service default", () => {
  const a = analyzeClient(
    [visit("Root colour", "2026-01-01"), visit("Root colour", "2026-03-02"), visit("Root colour", "2026-05-01")],
    profile,
    NOW,
  );
  assert.equal(a?.intervalSource, "personal");
  assert.equal(a?.intervalDays, 60);
});

test("thin history falls back to the service default", () => {
  const a = analyzeClient([visit("Keratin treatment", "2026-10-01")], profile, NOW);
  assert.equal(a?.intervalSource, "service_default");
  assert.equal(a?.intervalDays, 120);
  assert.equal(a?.overdue, false);
});

test("a recent visit for another service means not lapsed", () => {
  const a = analyzeClient([visit("Root colour", "2026-03-01"), visit("Gel manicure", "2026-11-01")], profile, NOW);
  assert.equal(a?.overdue, false);
});

test("no-shows and cancellations don't count as visits", () => {
  const a = analyzeClient([visit("Root colour", "2026-03-01"), visit("Root colour", "2026-10-30", "no_show")], profile, NOW);
  assert.equal(a?.lastVisit, "2026-03-01");
  assert.equal(a?.overdue, true);
});

test("a future booking is detected", () => {
  const a = analyzeClient([visit("Root colour", "2026-03-01"), visit("Root colour", "2026-12-01", "booked")], profile, NOW);
  assert.equal(a?.hasFutureBooking, true);
});

test("clients without consent never enter a campaign", () => {
  const db = openDb();
  seedOverdue(db, 10, "no");
  const f = buildCampaign(db, profile, "c1", NOW);
  assert.equal(f.no_consent, 10);
  assert.equal(f.eligible, 0);
});

test("control group is about the set ratio and saved once", () => {
  const db = openDb();
  seedOverdue(db, 100);
  const first = buildCampaign(db, profile, "c1", NOW);
  assert.equal(first.control, 20);
  assert.equal(first.treatment, 80);
  const snapshot = JSON.stringify(db.prepare("SELECT client_id, arm FROM campaign_assignments ORDER BY client_id").all());
  const second = buildCampaign(db, profile, "c1", new Date(NOW.getTime() + 86_400_000));
  assert.equal(second.already_built, true);
  assert.equal(JSON.stringify(db.prepare("SELECT client_id, arm FROM campaign_assignments ORDER BY client_id").all()), snapshot);
});

test("control clients are never messaged", async () => {
  const db = openDb();
  seedOverdue(db, 50);
  buildCampaign(db, profile, "c1", NOW);
  const channel = new ConsoleChannel(true);
  const r = await sendCampaign(db, profile, channel, "c1", { now: NOW, limit: 1000 });
  const control = db.prepare("SELECT c.phone FROM campaign_assignments a JOIN clients c ON c.id = a.client_id WHERE a.arm = 'control'").all() as unknown as { phone: string }[];
  assert.equal(r.sent, 40);
  assert.equal(control.length, 10);
  const sentTo = new Set(channel.sent.map((s) => s.to));
  assert.ok(control.every((c) => !sentTo.has(c.phone)));
});

test("sending is blocked outside the send window", async () => {
  const db = openDb();
  seedOverdue(db, 5);
  buildCampaign(db, profile, "c1", NOW);
  const channel = new ConsoleChannel(true);
  const night = new Date("2026-11-07T20:00:00Z"); // midnight in Dubai
  const r = await sendCampaign(db, profile, channel, "c1", { now: night });
  assert.equal(r.blocked, "outside_send_window");
  assert.equal(channel.sent.length, 0);
});

test("someone who opts out after the build is skipped", async () => {
  const db = openDb();
  seedOverdue(db, 10);
  buildCampaign(db, profile, "c1", NOW);
  db.prepare("UPDATE clients SET marketing_opt_in = 0, opted_out_at = ?").run(NOW.toISOString());
  const channel = new ConsoleChannel(true);
  const r = await sendCampaign(db, profile, channel, "c1", { now: NOW });
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 8);
});

test("re-running a send doesn't message anyone twice", async () => {
  const db = openDb();
  seedOverdue(db, 10);
  buildCampaign(db, profile, "c1", NOW);
  const channel = new ConsoleChannel(true);
  await sendCampaign(db, profile, channel, "c1", { now: NOW });
  const r = await sendCampaign(db, profile, channel, "c1", { now: NOW });
  assert.equal(r.sent, 0);
  assert.equal(channel.sent.length, 8);
});

test("a recent marketing message keeps a client out of the next campaign", async () => {
  const db = openDb();
  seedOverdue(db, 10);
  buildCampaign(db, profile, "c1", NOW);
  await sendCampaign(db, profile, new ConsoleChannel(true), "c1", { now: NOW });
  const f = buildCampaign(db, profile, "c2", new Date(NOW.getTime() + 5 * 86_400_000));
  assert.equal(f.contacted_recently, 8);
});
