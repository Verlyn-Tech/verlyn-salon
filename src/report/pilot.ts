import { ReporterOutput } from "../agents/schemas.ts";
import type { SalonProfile } from "../config.ts";
import type { DB } from "../db.ts";
import { LLMUnavailableError, type LLM } from "../llm/types.ts";

const DAY = 86_400_000;
const Z = 1.96;

export interface ArmStats {
  clients: number;
  rebooked: number;
  rate: number;
  revenue: number;
  revenuePerClient: number;
}

export type Verdict = "too_early" | "too_small" | "positive" | "inconclusive" | "negative";

export interface PilotReport {
  campaignId: string;
  windowDays: number;
  windowComplete: boolean;
  treatment: ArmStats;
  control: ArmStats;
  liftPoints: number;
  ci95: [number, number];
  verdict: Verdict;
  incrementalRevenue: number;
  messagesSent: number;
  estimatedMessagingCost: number;
  optOuts: number;
  reasons: Record<string, number>;
  handoffs: Record<string, number>;
  pendingBookingRequests: number;
  skipped: number;
}

function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** Newcombe's interval for a difference of proportions. It behaves well at small counts. */
export function differenceCI(x1: number, n1: number, x2: number, n2: number): [number, number] {
  const p1 = n1 ? x1 / n1 : 0;
  const p2 = n2 ? x2 / n2 : 0;
  const [l1, u1] = wilson(x1, n1);
  const [l2, u2] = wilson(x2, n2);
  const d = p1 - p2;
  return [d - Math.hypot(p1 - l1, u2 - p2), d + Math.hypot(u1 - p1, p2 - l2)];
}

const MIN_ARM = 30;

/**
 * Compares everyone assigned to each arm, including treatment clients who were
 * skipped or whose message failed. Counting only the ones reached would flatter
 * the result.
 */
export function computePilot(db: DB, profile: SalonProfile, campaignId: string, now: Date): PilotReport {
  const windowDays = profile.campaign.attribution_window_days;
  const rows = db.prepare(
    `SELECT client_id, arm, assigned_at, sent_at, skipped_reason FROM campaign_assignments WHERE campaign_id = ?`,
  ).all(campaignId) as unknown as { client_id: string; arm: "treatment" | "control"; assigned_at: string; sent_at: string | null; skipped_reason: string | null }[];
  if (!rows.length) throw new Error(`Campaign "${campaignId}" has no assignments`);

  const arms = {
    treatment: { clients: 0, rebooked: 0, revenue: 0 },
    control: { clients: 0, rebooked: 0, revenue: 0 },
  };
  let latestEnd = 0;
  let messagesSent = 0;
  let optOuts = 0;
  let skipped = 0;
  const treatmentIds: string[] = [];

  for (const r of rows) {
    const start = r.assigned_at.slice(0, 10);
    const endMs = Date.parse(start) + windowDays * DAY;
    latestEnd = Math.max(latestEnd, endMs);
    const end = new Date(endMs).toISOString().slice(0, 10);
    const visits = db.prepare(
      `SELECT status, amount_aed FROM visits
       WHERE client_id = ? AND visited_at >= ? AND visited_at <= ? AND status IN ('completed','booked')`,
    ).all(r.client_id, start, end) as unknown as { status: string; amount_aed: number }[];
    const arm = arms[r.arm];
    arm.clients++;
    if (visits.length) arm.rebooked++;
    arm.revenue += visits.filter((v) => v.status === "completed").reduce((sum, v) => sum + v.amount_aed, 0);
    if (r.arm === "treatment") {
      treatmentIds.push(r.client_id);
      if (r.sent_at) messagesSent++;
      if (r.skipped_reason) skipped++;
      const out = db.prepare("SELECT opted_out_at FROM clients WHERE id = ?").get(r.client_id) as { opted_out_at: string | null };
      if (out.opted_out_at && out.opted_out_at >= r.assigned_at) optOuts++;
    }
  }

  const stats = (a: typeof arms.treatment): ArmStats => ({
    ...a,
    rate: a.clients ? a.rebooked / a.clients : 0,
    revenuePerClient: a.clients ? a.revenue / a.clients : 0,
  });
  const treatment = stats(arms.treatment);
  const control = stats(arms.control);
  const ci95 = differenceCI(treatment.rebooked, treatment.clients, control.rebooked, control.clients);
  const windowComplete = now.getTime() >= latestEnd;

  let verdict: Verdict;
  if (!windowComplete) verdict = "too_early";
  else if (treatment.clients < MIN_ARM || control.clients < MIN_ARM) verdict = "too_small";
  else if (ci95[0] > 0) verdict = "positive";
  else if (ci95[1] < 0) verdict = "negative";
  else verdict = "inconclusive";

  const group = (sql: string, ...params: string[]) =>
    Object.fromEntries((db.prepare(sql).all(...params) as unknown as { k: string; n: number }[]).map((x) => [x.k, x.n]));
  const marks = treatmentIds.map(() => "?").join(",") || "''";

  return {
    campaignId,
    windowDays,
    windowComplete,
    treatment,
    control,
    liftPoints: treatment.rate - control.rate,
    ci95,
    verdict,
    incrementalRevenue: (treatment.revenuePerClient - control.revenuePerClient) * treatment.clients,
    messagesSent,
    estimatedMessagingCost: messagesSent * profile.campaign.aed_per_marketing_message,
    optOuts,
    reasons: group(`SELECT reason AS k, COUNT(*) AS n FROM retention_reasons WHERE client_id IN (${marks}) GROUP BY reason`, ...treatmentIds),
    handoffs: group("SELECT reason AS k, COUNT(*) AS n FROM handoffs WHERE status = 'open' GROUP BY reason"),
    pendingBookingRequests: (db.prepare("SELECT COUNT(*) AS n FROM booking_requests WHERE status = 'pending'").get() as { n: number }).n,
    skipped,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const aed = (x: number) => `AED ${Math.round(x).toLocaleString("en-US")}`;

const VERDICT_TEXT: Record<Verdict, string> = {
  too_early: "Too early to call. The measurement window hasn't finished, so don't quote these numbers yet.",
  too_small: "Too few clients in a group to draw a conclusion. Treat this as a rough guide only.",
  positive: "The messages made a measurable difference: the result stays above zero across the likely range.",
  inconclusive: "Inconclusive. The likely range includes zero, so this data can't show the messages caused the difference.",
  negative: "The messaged group did worse than the control group. Review the campaign before sending more.",
};

export function plainSummary(r: PilotReport): string {
  return (
    `${pct(r.treatment.rate)} of messaged clients came back or booked within ${r.windowDays} days, ` +
    `against ${pct(r.control.rate)} of the control group we didn't message. ${VERDICT_TEXT[r.verdict]}`
  );
}

/** Numbers the AI summary may use. Anything else in its text gets it rejected. */
function allowedNumbers(r: PilotReport): Set<string> {
  const values = [
    r.windowDays, r.treatment.clients, r.treatment.rebooked, r.control.clients, r.control.rebooked,
    r.messagesSent, r.optOuts, r.pendingBookingRequests, r.skipped,
    (r.treatment.rate * 100).toFixed(1), (r.control.rate * 100).toFixed(1),
    Math.abs(r.liftPoints * 100).toFixed(1), Math.abs(r.ci95[0] * 100).toFixed(1), Math.abs(r.ci95[1] * 100).toFixed(1),
    Math.round(Math.abs(r.incrementalRevenue)), Math.round(r.treatment.revenue), Math.round(r.control.revenue),
    ...Object.values(r.reasons), ...Object.values(r.handoffs), 95,
  ];
  return new Set(values.map(String));
}

export function numbersAreGrounded(text: string, r: PilotReport): boolean {
  const allowed = allowedNumbers(r);
  return (text.replace(/,(?=\d)/g, "").match(/\d+(?:\.\d+)?/g) ?? []).every((n) => allowed.has(n));
}

/**
 * Asks a free model for a friendlier owner summary. It only sees totals, and if
 * it invents a number or no model is available, the code-written summary is used.
 */
export async function ownerSummary(llm: LLM | null, r: PilotReport): Promise<{ text: string; source: "ai" | "code" }> {
  const fallback = { text: plainSummary(r), source: "code" as const };
  if (!llm) return fallback;
  try {
    const { data } = await llm.completeJson({
      agent: "reporter",
      schema: ReporterOutput,
      maxTokens: 800,
      system: `You write a short, plain-English pilot summary for a salon owner, 2 to 4 sentences, no jargon.
Use only the numbers in the data, exactly as given. Do not round them or calculate new ones.
You must keep this conclusion's meaning: "${VERDICT_TEXT[r.verdict]}" Never claim more certainty than that.`,
      user: JSON.stringify({
        window_days: r.windowDays,
        messaged_clients: r.treatment.clients,
        messaged_rebooked: r.treatment.rebooked,
        messaged_rate_percent: (r.treatment.rate * 100).toFixed(1),
        control_clients: r.control.clients,
        control_rebooked: r.control.rebooked,
        control_rate_percent: (r.control.rate * 100).toFixed(1),
        difference_points: Math.abs(r.liftPoints * 100).toFixed(1),
        opt_outs: r.optOuts,
        reasons_clients_gave: r.reasons,
      }),
    });
    return numbersAreGrounded(data.summary, r) && data.summary.trim() ? { text: data.summary.trim(), source: "ai" } : fallback;
  } catch (err) {
    if (err instanceof LLMUnavailableError) return fallback;
    throw err;
  }
}

function table(rows: Record<string, number>): string {
  const entries = Object.entries(rows);
  return entries.length ? entries.map(([k, n]) => `- ${k.replaceAll("_", " ")}: ${n}`).join("\n") : "- None";
}

export function renderReport(profile: SalonProfile, r: PilotReport, summary: string, banner?: string): string {
  return `# Pilot results: ${r.campaignId}
${banner ? `\n> **${banner}**\n` : ""}
**${profile.name}**, ${r.windowDays}-day measurement window${r.windowComplete ? "" : " (still running)"}

## Summary

${summary}

## Before and after, against the control group

| | Messaged | Not messaged (control) |
|---|---:|---:|
| Clients | ${r.treatment.clients} | ${r.control.clients} |
| Came back or booked | ${r.treatment.rebooked} | ${r.control.rebooked} |
| Rate | ${pct(r.treatment.rate)} | ${pct(r.control.rate)} |
| Revenue from completed visits | ${aed(r.treatment.revenue)} | ${aed(r.control.revenue)} |
| Revenue per client | ${aed(r.treatment.revenuePerClient)} | ${aed(r.control.revenuePerClient)} |

- **Difference:** ${pts(r.liftPoints)} percentage points (95% range ${pts(r.ci95[0])} to ${pts(r.ci95[1])})
- **Extra revenue estimate:** ${aed(r.incrementalRevenue)}. This is only meaningful when the conclusion above says the difference is real.
- **Conclusion:** ${VERDICT_TEXT[r.verdict]}

## Cost and safety

- Messages sent: ${r.messagesSent}
- Estimated WhatsApp cost: ${aed(r.estimatedMessagingCost)} before VAT, using the rate in the salon profile. Check it against your invoice.
- Opt-outs from messaged clients: ${r.optOuts}
- Skipped before sending (consent changed or already booked): ${r.skipped}

## Why clients said they stopped coming

${table(r.reasons)}

## Waiting for your team

- Booking requests to confirm: ${r.pendingBookingRequests}
- Open conversations by reason:
${table(r.handoffs)}

---
All clients assigned to each group are counted, including anyone the message didn't reach.
`;
}
