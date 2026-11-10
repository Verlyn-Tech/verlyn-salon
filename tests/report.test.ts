import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleChannel } from "../src/channels/types.ts";
import { openDb, type DB } from "../src/db.ts";
import { importClients, importVisits } from "../src/import/csv.ts";
import { LLMUnavailableError } from "../src/llm/types.ts";
import { computePilot, differenceCI, numbersAreGrounded, ownerSummary, renderReport } from "../src/report/pilot.ts";
import { buildCampaign, sendCampaign } from "../src/retention/campaign.ts";
import { CLIENT_HEADER, NOW, profile, ScriptedLLM, VISIT_HEADER } from "./helpers.ts";

const LATER = new Date(NOW.getTime() + 31 * 86_400_000);

/** Builds a campaign, then gives each arm a set number of return visits. */
async function pilot(count: number, treatmentBack: number, controlBack: number): Promise<DB> {
  const db = openDb();
  let clients = CLIENT_HEADER;
  let visits = VISIT_HEADER;
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(4, "0");
    clients += `c${n},Client,050000${n},en,yes,qr\n`;
    visits += `c${n},Root colour,2026-06-01,280,completed\n`;
  }
  importClients(db, clients, NOW);
  importVisits(db, visits, NOW);
  buildCampaign(db, profile, "p", NOW);
  await sendCampaign(db, profile, new ConsoleChannel(true), "p", { now: NOW, limit: 100_000 });
  const ids = (arm: string) => (db.prepare("SELECT client_id FROM campaign_assignments WHERE arm = ?").all(arm) as unknown as { client_id: string }[]).map((r) => r.client_id);
  let back = VISIT_HEADER;
  for (const id of ids("treatment").slice(0, treatmentBack)) back += `${id},Root colour,2026-11-20,280,completed\n`;
  for (const id of ids("control").slice(0, controlBack)) back += `${id},Root colour,2026-11-20,280,completed\n`;
  importVisits(db, back, NOW);
  return db;
}

test("the confidence range matches a published worked example", () => {
  // Newcombe (1998): 56/70 vs 48/80 gives roughly 0.0524 to 0.3339.
  const [low, high] = differenceCI(56, 70, 48, 80);
  assert.ok(Math.abs(low - 0.0524) < 0.001, String(low));
  assert.ok(Math.abs(high - 0.3339) < 0.001, String(high));
});

test("a clear gap is called positive", async () => {
  const r = computePilot(await pilot(200, 60, 2), profile, "p", LATER);
  assert.equal(r.treatment.clients, 160);
  assert.equal(r.control.clients, 40);
  assert.equal(r.verdict, "positive");
  assert.ok(r.incrementalRevenue > 0);
});

test("a small gap is called inconclusive, not a win", async () => {
  const r = computePilot(await pilot(200, 18, 4), profile, "p", LATER);
  assert.ok(r.treatment.rate > r.control.rate);
  assert.equal(r.verdict, "inconclusive");
});

test("the messaged group doing worse is reported honestly", async () => {
  const r = computePilot(await pilot(200, 5, 20), profile, "p", LATER);
  assert.equal(r.verdict, "negative");
});

test("no verdict before the window ends", async () => {
  const r = computePilot(await pilot(200, 60, 2), profile, "p", NOW);
  assert.equal(r.verdict, "too_early");
});

test("small pilots are flagged as too small", async () => {
  const r = computePilot(await pilot(50, 20, 0), profile, "p", LATER);
  assert.equal(r.verdict, "too_small");
});

test("treatment clients who never got the message still count", async () => {
  const db = await pilot(100, 10, 2);
  const before = computePilot(db, profile, "p", LATER).treatment.clients;
  db.prepare("UPDATE campaign_assignments SET sent_at = NULL, skipped_reason = 'no_longer_consented' WHERE arm = 'treatment' AND client_id IN (SELECT client_id FROM campaign_assignments WHERE arm = 'treatment' LIMIT 5)").run();
  const after = computePilot(db, profile, "p", LATER);
  assert.equal(after.treatment.clients, before);
  assert.equal(after.skipped, 5);
});

test("visits outside the window aren't credited", async () => {
  const db = await pilot(100, 0, 0);
  const id = (db.prepare("SELECT client_id FROM campaign_assignments WHERE arm = 'treatment' LIMIT 1").get() as { client_id: string }).client_id;
  importVisits(db, `${VISIT_HEADER}${id},Root colour,2027-03-01,280,completed\n`, NOW);
  assert.equal(computePilot(db, profile, "p", LATER).treatment.rebooked, 0);
});

test("an AI summary that invents a number is thrown away", async () => {
  const r = computePilot(await pilot(200, 60, 2), profile, "p", LATER);
  const made = await ownerSummary(new ScriptedLLM({ reporter: { summary: "Revenue grew by 480% this month!" } }), r);
  assert.equal(made.source, "code");
  assert.ok(!made.text.includes("480"));
  assert.equal(numbersAreGrounded(`${r.treatment.rebooked} of ${r.treatment.clients} came back.`, r), true);
});

test("a grounded AI summary is used", async () => {
  const r = computePilot(await pilot(200, 60, 2), profile, "p", LATER);
  const made = await ownerSummary(new ScriptedLLM({ reporter: { summary: `${r.treatment.rebooked} messaged clients came back.` } }), r);
  assert.equal(made.source, "ai");
});

test("the report still works when no free model is available", async () => {
  const r = computePilot(await pilot(200, 60, 2), profile, "p", LATER);
  const made = await ownerSummary(new ScriptedLLM({ reporter: new LLMUnavailableError("free_quota_exhausted") }), r);
  assert.equal(made.source, "code");
  assert.match(renderReport(profile, r, made.text), /Pilot results/);
});

test("the model only sees totals when writing the summary", async () => {
  const r = computePilot(await pilot(200, 60, 2), profile, "p", LATER);
  const llm = new ScriptedLLM({ reporter: { summary: "Good." } });
  await ownerSummary(llm, r);
  assert.doesNotMatch(llm.calls[0]?.user ?? "", /\+971|c0001|Client/);
});

test("a campaign preview leaves no trace", async () => {
  const db = await pilot(20, 0, 0);
  db.prepare("UPDATE campaign_assignments SET sent_at = NULL").run();
  db.exec("BEGIN");
  await sendCampaign(db, profile, new ConsoleChannel(true), "p", { now: NOW });
  db.exec("ROLLBACK");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM campaign_assignments WHERE sent_at IS NOT NULL").get() as { n: number }).n, 0);
});

test("bookings confirmed in the staff dashboard count as coming back", async () => {
  const db = await pilot(100, 0, 0);
  const id = (db.prepare("SELECT client_id FROM campaign_assignments WHERE arm = 'treatment' LIMIT 1").get() as { client_id: string }).client_id;
  db.prepare("INSERT INTO booking_requests (id, client_id, type, created_at) VALUES (1, ?, 'new', '2026-11-08')").run(id);
  db.prepare("INSERT INTO availability_slots (id, service_id, starts_at, ends_at, status, created_at) VALUES (1, 'root_colour', '2026-11-20T15:00', '2026-11-20T17:00', 'booked', '2026-11-08')").run();
  db.prepare("INSERT INTO appointments (client_id, request_id, slot_id, service_id, starts_at, ends_at, created_at) VALUES (?, 1, 1, 'root_colour', '2026-11-20T15:00', '2026-11-20T17:00', '2026-11-08')").run(id);
  const r = computePilot(db, profile, "p", LATER);
  assert.equal(r.treatment.rebooked, 1);
  assert.equal(r.treatment.revenue, 0, "revenue waits for the completed visit");
});
