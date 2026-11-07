import { createHash } from "node:crypto";
import type { Channel } from "../channels/types.ts";
import type { SalonProfile } from "../config.ts";
import { audit, type DB } from "../db.ts";
import { analyzeClient, type OverdueAnalysis, type VisitRow } from "./overdue.ts";

const DAY = 86_400_000;
/** Respect a clear "no" from an earlier conversation. */
const CLOSED_REASONS = ["moved", "switched_salon", "not_interested", "bad_experience"];

export interface Funnel {
  total: number;
  no_consent: number;
  opted_out: number;
  no_visit_history: number;
  not_overdue: number;
  too_lapsed: number;
  future_booking: number;
  open_staff_case: number;
  said_no_before: number;
  contacted_recently: number;
  eligible: number;
  treatment: number;
  control: number;
  already_built: boolean;
}

interface ClientRow {
  id: string;
  marketing_opt_in: number;
  opted_out_at: string | null;
}

function contactedRecently(db: DB, clientId: string, profile: SalonProfile, now: Date): boolean {
  const since = new Date(now.getTime() - profile.campaign.contact_cooldown_days * DAY).toISOString();
  return Boolean(
    db.prepare("SELECT 1 FROM messages WHERE client_id = ? AND kind = 'template' AND at >= ? LIMIT 1").get(clientId, since),
  );
}

function hashOrder(campaignId: string, clientId: string): string {
  return createHash("sha256").update(`${campaignId}:${clientId}`).digest("hex");
}

/**
 * Splits eligible clients into treatment and control before anything is sent.
 * Splitting inside "how overdue" groups keeps both arms comparable. The split is
 * saved and never redrawn, so results can't be cherry-picked afterwards.
 */
export function buildCampaign(db: DB, profile: SalonProfile, campaignId: string, now: Date): Funnel {
  const clients = db.prepare("SELECT id, marketing_opt_in, opted_out_at FROM clients").all() as unknown as ClientRow[];
  const funnel: Funnel = {
    total: clients.length, no_consent: 0, opted_out: 0, no_visit_history: 0, not_overdue: 0, too_lapsed: 0,
    future_booking: 0, open_staff_case: 0, said_no_before: 0, contacted_recently: 0, eligible: 0,
    treatment: 0, control: 0, already_built: false,
  };

  const eligible: { id: string; a: OverdueAnalysis }[] = [];
  for (const c of clients) {
    if (c.opted_out_at) { funnel.opted_out++; continue; }
    if (!c.marketing_opt_in) { funnel.no_consent++; continue; }
    const visits = db.prepare("SELECT service, visited_at, status FROM visits WHERE client_id = ?").all(c.id) as unknown as VisitRow[];
    const a = analyzeClient(visits, profile, now);
    if (!a) { funnel.no_visit_history++; continue; }
    if (a.hasFutureBooking) { funnel.future_booking++; continue; }
    if (a.tooLapsed) { funnel.too_lapsed++; continue; }
    if (!a.overdue) { funnel.not_overdue++; continue; }
    if (db.prepare("SELECT 1 FROM handoffs WHERE client_id = ? AND status = 'open'").get(c.id)) { funnel.open_staff_case++; continue; }
    const marks = CLOSED_REASONS.map(() => "?").join(",");
    if (db.prepare(`SELECT 1 FROM retention_reasons WHERE client_id = ? AND reason IN (${marks}) LIMIT 1`).get(c.id, ...CLOSED_REASONS)) {
      funnel.said_no_before++;
      continue;
    }
    if (contactedRecently(db, c.id, profile, now)) { funnel.contacted_recently++; continue; }
    eligible.push({ id: c.id, a });
  }
  funnel.eligible = eligible.length;

  const existing = db.prepare("SELECT arm, COUNT(*) AS n FROM campaign_assignments WHERE campaign_id = ? GROUP BY arm").all(campaignId) as unknown as { arm: string; n: number }[];
  if (existing.length) {
    funnel.already_built = true;
    funnel.treatment = existing.find((r) => r.arm === "treatment")?.n ?? 0;
    funnel.control = existing.find((r) => r.arm === "control")?.n ?? 0;
    return funnel;
  }

  const strata = new Map<string, typeof eligible>();
  for (const e of eligible) {
    const key = e.a.ratio < 1.75 ? "recent" : e.a.ratio < 3 ? "mid" : "long";
    strata.set(key, [...(strata.get(key) ?? []), e]);
  }
  const insert = db.prepare(
    `INSERT INTO campaign_assignments (campaign_id, client_id, arm, assigned_at, last_visit_at, interval_days, service_label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const group of strata.values()) {
    group.sort((x, y) => hashOrder(campaignId, x.id).localeCompare(hashOrder(campaignId, y.id)));
    const controlCount = Math.round(group.length * profile.campaign.control_ratio);
    group.forEach((e, i) => {
      const arm = i < controlCount ? "control" : "treatment";
      funnel[arm]++;
      insert.run(campaignId, e.id, arm, now.toISOString(), e.a.lastVisit, e.a.intervalDays, e.a.service?.id ?? null);
    });
  }
  audit(db, now, null, "campaign", "built", { campaignId, ...funnel });
  return funnel;
}

export function hourIn(timeZone: string, now: Date): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(h);
}

export interface SendReport {
  blocked?: "outside_send_window";
  sent: number;
  skipped: number;
  failed: number;
  remaining: number;
}

/** Sends win-back templates to the treatment arm. Control clients are never selected. */
export async function sendCampaign(
  db: DB,
  profile: SalonProfile,
  channel: Channel,
  campaignId: string,
  options: { now: Date; limit?: number },
): Promise<SendReport> {
  const { now, limit = 50 } = options;
  const report: SendReport = { sent: 0, skipped: 0, failed: 0, remaining: 0 };
  const pending = () =>
    db.prepare(
      `SELECT COUNT(*) AS n FROM campaign_assignments
       WHERE campaign_id = ? AND arm = 'treatment' AND sent_at IS NULL AND skipped_reason IS NULL`,
    ).get(campaignId) as { n: number };

  const hour = hourIn(profile.timezone, now);
  const { start_hour, end_hour } = profile.campaign.send_window;
  if (hour < start_hour || hour >= end_hour) {
    report.blocked = "outside_send_window";
    report.remaining = pending().n;
    return report;
  }

  const rows = db.prepare(
    `SELECT a.client_id, a.service_label, c.first_name, c.phone, c.language, c.marketing_opt_in, c.opted_out_at
     FROM campaign_assignments a JOIN clients c ON c.id = a.client_id
     WHERE a.campaign_id = ? AND a.arm = 'treatment' AND a.sent_at IS NULL AND a.skipped_reason IS NULL
     LIMIT ?`,
  ).all(campaignId, limit) as unknown as {
    client_id: string; service_label: string | null; first_name: string | null; phone: string;
    language: string; marketing_opt_in: number; opted_out_at: string | null;
  }[];

  const skip = db.prepare("UPDATE campaign_assignments SET skipped_reason = ? WHERE campaign_id = ? AND client_id = ?");
  for (const r of rows) {
    // Consent can change between building and sending, so it's checked again here.
    if (r.opted_out_at || !r.marketing_opt_in) {
      skip.run("no_longer_consented", campaignId, r.client_id);
      report.skipped++;
      continue;
    }
    const booked = db.prepare("SELECT 1 FROM visits WHERE client_id = ? AND status = 'booked' AND visited_at >= ? LIMIT 1").get(r.client_id, now.toISOString().slice(0, 10));
    if (booked) {
      skip.run("booked_since_build", campaignId, r.client_id);
      report.skipped++;
      continue;
    }
    const lang = r.language === "ar" ? "ar" : "en";
    const tpl = profile.templates.winback[lang];
    const service = profile.services.find((s) => s.id === r.service_label);
    const params = [
      r.first_name ?? (lang === "ar" ? "عميلنا العزيز" : "there"),
      (lang === "ar" ? service?.name_ar : service?.name_en) ?? (lang === "ar" ? "موعدك" : "next visit"),
      profile.booking_link,
    ];
    try {
      const id = await channel.sendTemplate(r.phone, tpl.name, tpl.language, params);
      const at = now.toISOString();
      db.prepare("UPDATE campaign_assignments SET sent_at = ? WHERE campaign_id = ? AND client_id = ?").run(at, campaignId, r.client_id);
      db.prepare("INSERT INTO messages (client_id, direction, body, kind, provider_id, agent, at) VALUES (?, 'out', ?, 'template', ?, 'campaign', ?)").run(
        r.client_id,
        `${tpl.name}: ${params.slice(0, 2).join(" | ")}`,
        id,
        at,
      );
      report.sent++;
    } catch (err) {
      audit(db, now, r.client_id, "campaign", "send_failed", { error: String(err) });
      report.failed++;
    }
  }
  report.remaining = pending().n;
  audit(db, now, null, "campaign", "sent", { campaignId, ...report });
  return report;
}
