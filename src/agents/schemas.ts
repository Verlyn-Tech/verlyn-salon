import { z } from "zod";

export const RouterOutput = z.object({
  intent: z.enum([
    "enquiry",
    "booking",
    "reschedule_or_cancel",
    "winback_reply",
    "complaint",
    "sensitive",
    "human_request",
    "opt_out",
    "off_topic",
    "unclear",
  ]),
  language: z.enum(["en", "ar", "arabizi", "other"]),
  // Some models return this as text, like "0.95".
  confidence: z.coerce.number().min(0).max(1),
});

export const EnquiryOutput = z.object({
  reply: z.string(),
  needs_human: z.boolean(),
  handoff_reason: z.string().nullable(),
});

export const BookingOutput = z.object({
  reply: z.string(),
  action: z.enum(["none", "send_booking_link", "request_new", "request_reschedule", "request_cancel"]),
  service_id: z.string().nullable(),
  preferred_time: z.string().nullable(),
  needs_human: z.boolean(),
  // Some models send ids as text; the orchestrator checks it against the real open slots.
  slot_id: z.union([z.number(), z.string(), z.null()]).optional(),
});

export const RetentionOutput = z.object({
  reason: z.enum(["price", "moved", "switched_salon", "bad_experience", "busy", "forgot", "wants_to_book", "not_interested", "other"]),
  wants_no_more_messages: z.boolean(),
  reply: z.string(),
  action: z.enum(["offer_booking", "close", "handoff"]),
});

export const GuardOutput = z.object({
  pass: z.boolean(),
  issues: z.array(z.string()),
});

export const ReporterOutput = z.object({
  summary: z.string(),
});

export type RouterResult = z.infer<typeof RouterOutput>;
export type EnquiryResult = z.infer<typeof EnquiryOutput>;
export type BookingResult = z.infer<typeof BookingOutput>;
export type RetentionResult = z.infer<typeof RetentionOutput>;
export type GuardResult = z.infer<typeof GuardOutput>;
