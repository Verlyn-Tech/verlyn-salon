import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const Template = z.object({ name: z.string(), language: z.string(), preview: z.string() });

export const SalonProfileSchema = z.object({
  name: z.string(),
  location: z.string(),
  timezone: z.string(),
  hours: z.string(),
  booking_link: z.url(),
  booking_mode: z.enum(["link_and_staff_request"]),
  default_interval_days: z.number().int().positive(),
  policies: z.array(z.string()),
  services: z
    .array(
      z.object({
        id: z.string(),
        name_en: z.string(),
        name_ar: z.string(),
        price_aed: z.number().nonnegative(),
        duration_min: z.number().int().positive(),
        interval_days: z.number().int().positive(),
        aliases: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  campaign: z.object({
    control_ratio: z.number().min(0.05).max(0.5),
    overdue_multiplier: z.number().min(1),
    max_days_lapsed: z.number().int().positive(),
    contact_cooldown_days: z.number().int().nonnegative(),
    attribution_window_days: z.number().int().positive(),
    send_window: z.object({
      start_hour: z.number().int().min(0).max(23),
      end_hour: z.number().int().min(1).max(24),
    }),
    aed_per_marketing_message: z.number().nonnegative(),
  }),
  templates: z.object({ winback: z.object({ en: Template, ar: Template }) }),
});

export type SalonProfile = z.infer<typeof SalonProfileSchema>;
export type Service = SalonProfile["services"][number];

export function loadProfile(path: string): SalonProfile {
  return SalonProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Loads .env when present. Real environment variables win. */
export function loadEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
