import type { SalonProfile } from "../config.ts";

const DAY = 86_400_000;
const NAMES = ["Amal", "Sara", "Layla", "Noor", "Hind", "Maya", "Reem", "Dana", "Fatima", "Priya", "Joy", "Elena", "Aisha", "Mona", "Zainab", "Grace"];

/** Small seeded generator, so the sample data is the same on every run. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fictional clients with obviously fake numbers (05000xxxxx). Never real data. */
export function sampleData(profile: SalonProfile, now: Date, count = 400): { clients: string; visits: string } {
  const rand = seededRandom(20261107);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  let clients = "client_id,first_name,phone,language,whatsapp_marketing_consent,consent_source\n";
  let visits = "client_id,service,date,amount_aed,status\n";
  for (let i = 0; i < count; i++) {
    const id = `s${String(i).padStart(4, "0")}`;
    const consented = rand() < 0.65;
    clients += `${id},${pick(NAMES)},05000${String(i).padStart(5, "0")},${rand() < 0.3 ? "ar" : "en"},${consented ? "yes" : "no"},${consented ? "qr_checkout" : ""}\n`;
    const service = pick(profile.services);
    const interval = service.interval_days * (0.8 + rand() * 0.4);
    let daysAgo = 10 + Math.floor(rand() * 300);
    const history = 1 + Math.floor(rand() * 4);
    for (let v = 0; v < history; v++) {
      const date = new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
      visits += `${id},${service.name_en},${date},${service.price_aed},completed\n`;
      daysAgo += Math.round(interval);
    }
  }
  return { clients, visits };
}
