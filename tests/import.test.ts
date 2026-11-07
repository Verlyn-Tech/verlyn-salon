import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { importClients, importVisits, normalizePhone, parseCsv, parseDate } from "../src/import/csv.ts";

const NOW = new Date("2026-11-07T08:00:00Z");
const HEADER = "client_id,first_name,phone,language,whatsapp_marketing_consent,consent_source\n";

test("csv parser handles quotes, commas and newlines", () => {
  const rows = parseCsv('a,b\n"x, y","line1\nline2"\n"he said ""hi""",2\n');
  assert.deepEqual(rows[0], { a: "x, y", b: "line1\nline2" });
  assert.equal(rows[1]?.["a"], 'he said "hi"');
});

test("phone normalisation covers UAE formats and rejects junk", () => {
  assert.equal(normalizePhone("050 123 4567"), "+971501234567");
  assert.equal(normalizePhone("971501234567"), "+971501234567");
  assert.equal(normalizePhone("00971-50-123-4567"), "+971501234567");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("not a phone"), null);
});

test("dates accept ISO and DD/MM/YYYY and reject impossible dates", () => {
  assert.equal(parseDate("2026-03-05"), "2026-03-05");
  assert.equal(parseDate("05/03/2026"), "2026-03-05");
  assert.equal(parseDate("31/02/2026"), null);
});

test("consent needs an explicit yes and a recorded source", () => {
  const db = openDb();
  const r = importClients(
    db,
    HEADER +
      "c1,Amal,0501111111,en,yes,qr_checkout\n" +
      "c2,Ben,0502222222,en,yes,\n" +
      "c3,Cai,0503333333,en,,qr_checkout\n" +
      "c4,Dee,0504444444,en,maybe,qr_checkout\n",
    NOW,
  );
  assert.equal(r.imported, 4);
  assert.equal(r.consented, 1);
  const on = db.prepare("SELECT id FROM clients WHERE marketing_opt_in = 1").all() as { id: string }[];
  assert.deepEqual(on.map((x) => x.id), ["c1"]);
});

test("re-import never lifts an opt-out", () => {
  const db = openDb();
  importClients(db, HEADER + "c1,Amal,0501111111,en,yes,qr\n", NOW);
  db.prepare("UPDATE clients SET marketing_opt_in = 0, opted_out_at = ? WHERE id = 'c1'").run(NOW.toISOString());
  importClients(db, HEADER + "c1,Amal,0501111111,en,yes,qr\n", NOW);
  const row = db.prepare("SELECT marketing_opt_in FROM clients WHERE id = 'c1'").get() as { marketing_opt_in: number };
  assert.equal(row.marketing_opt_in, 0);
});

test("bad rows are reported, not silently dropped", () => {
  const db = openDb();
  const r = importClients(db, HEADER + ",No,0501111111,en,yes,qr\nc2,Bad,123,en,yes,qr\nc3,A,0503333333,en,yes,qr\nc4,B,0503333333,en,yes,qr\n", NOW);
  assert.equal(r.imported, 1);
  assert.deepEqual(r.rejected.map((x) => x.reason), ["missing client_id", "invalid phone", "duplicate phone (already c3)"]);
});

test("visit import is idempotent and updates status", () => {
  const db = openDb();
  importClients(db, HEADER + "c1,Amal,0501111111,en,yes,qr\n", NOW);
  const head = "client_id,service,date,amount_aed,status\n";
  importVisits(db, head + "c1,Keratin,2026-12-01,750,booked\n", NOW);
  const r = importVisits(db, head + "c1,Keratin,2026-12-01,750,completed\nzz,Keratin,2026-12-01,750,completed\nc1,Cut,bad,10,completed\n", NOW);
  assert.equal(r.imported, 1);
  assert.equal(r.rejected.length, 2);
  const rows = db.prepare("SELECT status FROM visits").all() as { status: string }[];
  assert.deepEqual(rows.map((x) => x.status), ["completed"]);
});
