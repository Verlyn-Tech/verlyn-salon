import type { SalonProfile, Service } from "../config.ts";

export interface VisitRow {
  service: string;
  visited_at: string;
  status: string;
}

export interface OverdueAnalysis {
  lastVisit: string;
  intervalDays: number;
  intervalSource: "personal" | "service_default" | "salon_default";
  daysSince: number;
  /** Days since the last visit divided by the client's normal interval. */
  ratio: number;
  overdue: boolean;
  tooLapsed: boolean;
  hasFutureBooking: boolean;
  service: Service | null;
}

const DAY = 86_400_000;
const MIN_PERSONAL_GAPS = 2;

export function matchService(name: string, profile: SalonProfile): Service | null {
  const n = name.trim().toLowerCase();
  return (
    profile.services.find(
      (s) =>
        s.id === n ||
        s.name_en.toLowerCase() === n ||
        s.name_ar === name.trim() ||
        s.aliases.some((a) => a.toLowerCase() === n),
    ) ??
    profile.services.find((s) => s.aliases.some((a) => n.includes(a.toLowerCase()))) ??
    null
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Works out whether a client is overdue, judged against their own habits where
 * there is enough history. A client who was in last week for nails isn't lapsed
 * just because their colour is due, so only the most recent visit counts.
 */
export function analyzeClient(visits: VisitRow[], profile: SalonProfile, now: Date): OverdueAnalysis | null {
  const today = now.toISOString().slice(0, 10);
  const completed = visits
    .filter((v) => v.status === "completed" && v.visited_at <= today)
    .sort((a, b) => a.visited_at.localeCompare(b.visited_at));
  const last = completed.at(-1);
  if (!last) return null;

  const service = matchService(last.service, profile);
  const sameService = completed.filter((v) => matchService(v.service, profile)?.id === service?.id);
  const dates = [...new Set(sameService.map((v) => v.visited_at))];
  const gaps = dates
    .slice(1)
    .map((d, i) => (Date.parse(d) - Date.parse(dates[i]!)) / DAY);

  let intervalDays: number;
  let intervalSource: OverdueAnalysis["intervalSource"];
  if (service && gaps.length >= MIN_PERSONAL_GAPS) {
    intervalDays = Math.round(Math.min(180, Math.max(14, median(gaps))));
    intervalSource = "personal";
  } else if (service) {
    intervalDays = service.interval_days;
    intervalSource = "service_default";
  } else {
    intervalDays = profile.default_interval_days;
    intervalSource = "salon_default";
  }

  const daysSince = Math.floor((Date.parse(today) - Date.parse(last.visited_at)) / DAY);
  const { overdue_multiplier, max_days_lapsed } = profile.campaign;
  return {
    lastVisit: last.visited_at,
    intervalDays,
    intervalSource,
    daysSince,
    ratio: daysSince / intervalDays,
    overdue: daysSince > intervalDays * overdue_multiplier,
    tooLapsed: daysSince > max_days_lapsed,
    hasFutureBooking: visits.some((v) => v.status === "booked" && v.visited_at >= today),
    service,
  };
}
