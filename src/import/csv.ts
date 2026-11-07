import { audit, type DB } from "../db.ts";

/** RFC 4180 style parser: quoted fields, escaped quotes, commas and newlines in quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** Returns E.164, assuming UAE for local numbers, or null when it isn't a usable number. */
export function normalizePhone(raw: string): string | null {
  let p = raw.replace(/[\s().-]/g, "");
  if (p.startsWith("00")) p = `+${p.slice(2)}`;
  if (/^05\d{8}$/.test(p)) p = `+971${p.slice(1)}`;
  if (/^9715\d{8}$/.test(p)) p = `+${p}`;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

/** Only an explicit yes counts. Blank, unknown or "maybe" all mean no consent. */
export function parseConsent(raw: string): boolean {
  return ["yes", "y", "true", "1", "opted_in"].includes(raw.trim().toLowerCase());
}

export function parseDate(raw: string): string | null {
  const v = raw.trim();
  let iso: string | null = null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) iso = v.slice(0, 10);
  else if (dmy) iso = `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export interface ImportReport {
  rows: number;
  imported: number;
  rejected: { row: number; reason: string }[];
}

/**
 * Columns: client_id, first_name, phone, language, whatsapp_marketing_consent, consent_source
 * Re-importing never lifts an opt-out, and consent needs a recorded source.
 */
export function importClients(db: DB, csv: string, now: Date): ImportReport & { consented: number } {
  const rows = parseCsv(csv);
  const report = { rows: rows.length, imported: 0, consented: 0, rejected: [] as ImportReport["rejected"] };
  const at = now.toISOString();
  rows.forEach((r, i) => {
    const line = i + 2;
    const id = r["client_id"];
    if (!id) return void report.rejected.push({ row: line, reason: "missing client_id" });
    const phone = normalizePhone(r["phone"] ?? "");
    if (!phone) return void report.rejected.push({ row: line, reason: "invalid phone" });
    const owner = db.prepare("SELECT id FROM clients WHERE phone = ?").get(phone) as { id: string } | undefined;
    if (owner && owner.id !== id) {
      return void report.rejected.push({ row: line, reason: `duplicate phone (already ${owner.id})` });
    }
    const source = r["consent_source"] ?? "";
    const consent = parseConsent(r["whatsapp_marketing_consent"] ?? "") && source !== "";
    const language = r["language"]?.toLowerCase().startsWith("ar") ? "ar" : "en";
    const prior = db.prepare("SELECT marketing_opt_in, opted_out_at FROM clients WHERE id = ?").get(id) as
      | { marketing_opt_in: number; opted_out_at: string | null }
      | undefined;
    const effective = consent && !prior?.opted_out_at;
    db.prepare(
      `INSERT INTO clients (id, first_name, phone, language, marketing_opt_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, phone = excluded.phone,
         language = excluded.language, marketing_opt_in = excluded.marketing_opt_in`,
    ).run(id, r["first_name"] || null, phone, language, effective ? 1 : 0, at);
    if (effective !== Boolean(prior?.marketing_opt_in)) {
      db.prepare("INSERT INTO consent_log (client_id, event, source, at) VALUES (?, ?, ?, ?)").run(
        id,
        effective ? "opt_in" : "consent_removed",
        source || "csv_import",
        at,
      );
    }
    report.imported++;
    if (effective) report.consented++;
  });
  audit(db, now, null, "import", "clients", { rows: report.rows, imported: report.imported, consented: report.consented, rejected: report.rejected.length });
  return report;
}

const STATUS: Record<string, string> = {
  completed: "completed", complete: "completed", done: "completed",
  no_show: "no_show", "no-show": "no_show", noshow: "no_show",
  cancelled: "cancelled", canceled: "cancelled",
  booked: "booked", confirmed: "booked", upcoming: "booked",
};

/** Columns: client_id, service, date, amount_aed, status. Re-importing updates the status. */
export function importVisits(db: DB, csv: string, now: Date): ImportReport {
  const rows = parseCsv(csv);
  const report: ImportReport = { rows: rows.length, imported: 0, rejected: [] };
  rows.forEach((r, i) => {
    const line = i + 2;
    const id = r["client_id"] ?? "";
    if (!db.prepare("SELECT 1 FROM clients WHERE id = ?").get(id)) {
      return void report.rejected.push({ row: line, reason: "unknown client_id" });
    }
    const date = parseDate(r["date"] ?? "");
    if (!date) return void report.rejected.push({ row: line, reason: "invalid date" });
    const status = STATUS[(r["status"] ?? "completed").toLowerCase()];
    if (!status) return void report.rejected.push({ row: line, reason: "unknown status" });
    const amount = Number(r["amount_aed"] || 0);
    if (!Number.isFinite(amount) || amount < 0) return void report.rejected.push({ row: line, reason: "invalid amount" });
    db.prepare(
      `INSERT INTO visits (client_id, service, visited_at, amount_aed, status) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(client_id, service, visited_at) DO UPDATE SET amount_aed = excluded.amount_aed, status = excluded.status`,
    ).run(id, r["service"] || "unknown", date, amount, status);
    report.imported++;
  });
  audit(db, now, null, "import", "visits", { rows: report.rows, imported: report.imported, rejected: report.rejected.length });
  return report;
}
