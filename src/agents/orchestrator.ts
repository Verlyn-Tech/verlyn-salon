import { randomUUID } from "node:crypto";
import type { Channel } from "../channels/types.ts";
import type { SalonProfile } from "../config.ts";
import { audit, type DB } from "../db.ts";
import { LLMUnavailableError, type JsonResult, type LLM } from "../llm/types.ts";
import { fillName, redact } from "../privacy/redact.ts";
import { effectiveProfile } from "../staff/operations.ts";
import { checkReply, FIXED_TEXT, hardHandoffReason, hasArabic, isOptOut } from "./rules.ts";
import type { BookingResult, EnquiryResult, RetentionResult } from "./schemas.ts";
import {
  runBooking,
  runEnquiry,
  runGuardReview,
  runRetention,
  runRouter,
  type TurnContext,
} from "./specialists.ts";

export interface InboundMessage {
  from: string;
  text: string;
  kind?: "text" | "other";
  providerId?: string;
}

export interface Deps {
  db: DB;
  profile: SalonProfile;
  llm: LLM;
  channel: Channel;
  now: () => Date;
  guardLlm?: boolean;
}

export type Outcome =
  | "duplicate"
  | "opted_out"
  | "queued_for_staff"
  | "handoff"
  | "off_topic"
  | "replied"
  | "closed";

export interface TurnResult {
  outcome: Outcome;
  path: string[];
  reason?: string;
  reply?: string;
  model?: string[];
}

interface ClientRow {
  id: string;
  first_name: string | null;
  language: string;
}

const CONFIDENCE_FLOOR = 0.6;
const WINBACK_WINDOW_DAYS = 14;
const HISTORY_LIMIT = 8;

function findOrCreateClient(db: DB, phone: string, at: Date): ClientRow {
  const existing = db.prepare("SELECT id, first_name, language FROM clients WHERE phone = ?").get(phone) as
    | ClientRow
    | undefined;
  if (existing) return existing;
  const id = `lead-${randomUUID()}`;
  // A new enquirer has given no marketing consent, so marketing_opt_in stays 0.
  db.prepare("INSERT INTO clients (id, phone, created_at) VALUES (?, ?, ?)").run(id, phone, at.toISOString());
  return { id, first_name: null, language: "en" };
}

function buildContext(db: DB, client: ClientRow, text: string, messageId: number | bigint, at: Date): TurnContext {
  const rows = db
    .prepare(
      `SELECT direction, body FROM messages WHERE client_id = ? AND id < ? AND kind != 'template'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(client.id, messageId, HISTORY_LIMIT) as { direction: string; body: string }[];
  const since = new Date(at.getTime() - WINBACK_WINDOW_DAYS * 86_400_000).toISOString();
  const winback = db
    .prepare(
      `SELECT service_label FROM campaign_assignments
       WHERE client_id = ? AND arm = 'treatment' AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(client.id, since) as { service_label: string | null } | undefined;
  return {
    history: rows.reverse().map((r) => ({
      from: r.direction === "in" ? ("customer" as const) : ("salon" as const),
      text: redact(r.body, client.first_name),
    })),
    message: redact(text, client.first_name),
    isWinbackReply: Boolean(winback),
    lastService: winback?.service_label ?? null,
  };
}

/**
 * Runs one inbound message through the agents:
 *
 *   code rules -> router -> enquiry | booking | retention -> code guard -> AI guard -> send
 *
 * Anything uncertain or failing at any step becomes a staff handoff. Agents only
 * propose; side effects happen here, and only after the guards pass.
 */
export async function handleInbound(deps: Deps, msg: InboundMessage): Promise<TurnResult> {
  const { db, llm, channel } = deps;
  // Read staff price edits on each turn, including when the webhook stays running.
  const profile = effectiveProfile(db, deps.profile);
  const at = deps.now();
  const iso = at.toISOString();

  if (msg.providerId && db.prepare("SELECT 1 FROM messages WHERE provider_id = ?").get(msg.providerId)) {
    return { outcome: "duplicate", path: ["dedupe"] };
  }

  const client = findOrCreateClient(db, msg.from, at);
  const kind = msg.kind ?? "text";
  const inserted = db
    .prepare("INSERT INTO messages (client_id, direction, body, kind, provider_id, at) VALUES (?, 'in', ?, ?, ?, ?)")
    .run(client.id, msg.text, kind, msg.providerId ?? null, iso);
  const profileLang: "en" | "ar" = client.language === "ar" ? "ar" : "en";
  // Follow the language they just wrote in. A voice note has no text to go by.
  const lang: "en" | "ar" = kind !== "text" ? profileLang : hasArabic(msg.text) ? "ar" : "en";
  const path: string[] = [];
  const models: string[] = [];

  const send = async (body: string, agent: string) => {
    const id = await channel.sendText(msg.from, body);
    db.prepare("INSERT INTO messages (client_id, direction, body, kind, provider_id, agent, at) VALUES (?, 'out', ?, 'text', ?, ?, ?)").run(
      client.id,
      body,
      id,
      agent,
      iso,
    );
  };

  const handoff = async (reason: string, holding = FIXED_TEXT.holding): Promise<TurnResult> => {
    db.prepare("INSERT INTO handoffs (client_id, reason, summary, created_at) VALUES (?, ?, ?, ?)").run(
      client.id,
      reason,
      msg.text.slice(0, 500),
      iso,
    );
    audit(db, at, client.id, "orchestrator", "handoff", { reason, path });
    await send(holding[lang], "orchestrator");
    return { outcome: "handoff", path: [...path, "handoff"], reason, reply: holding[lang], model: models };
  };

  const track = <T>(agent: string, res: JsonResult<T>): T => {
    path.push(agent);
    models.push(res.model);
    audit(db, at, client.id, agent, "completed", { model: res.model, attempts: res.attempts });
    return res.data;
  };

  const optOut = async (source: string, replyLang: "en" | "ar"): Promise<void> => {
    db.prepare("UPDATE clients SET marketing_opt_in = 0, opted_out_at = ? WHERE id = ?").run(iso, client.id);
    db.prepare("INSERT INTO consent_log (client_id, event, source, at) VALUES (?, 'opt_out', ?, ?)").run(client.id, source, iso);
    await send(FIXED_TEXT.optedOut[replyLang], "orchestrator");
  };

  // 1. Code rules run first and use no model at all.
  if (kind === "text" && isOptOut(msg.text)) {
    // Arabic templates tell people to send the English word STOP, so a Latin
    // keyword says nothing about language. Use their saved preference.
    await optOut("whatsapp_reply", lang === "ar" ? "ar" : profileLang);
    return { outcome: "opted_out", path: ["rules"] };
  }

  const open = db.prepare("SELECT 1 FROM handoffs WHERE client_id = ? AND status = 'open'").get(client.id);
  if (open) {
    // Staff own this conversation. The assistant must not talk over them.
    audit(db, at, client.id, "orchestrator", "queued_for_staff");
    return { outcome: "queued_for_staff", path: ["rules"] };
  }

  path.push("rules");
  if (kind !== "text") return handoff("non_text_message", FIXED_TEXT.nonText);
  const hard = hardHandoffReason(msg.text);
  if (hard) return handoff(hard);

  // 2. Agents.
  const ctx = buildContext(db, client, msg.text, inserted.lastInsertRowid, at);
  try {
    const route = track("router", await runRouter(llm, ctx));
    const replyLang = route.language === "ar" || route.language === "arabizi" ? "ar" : lang;
    // Checked before the confidence floor: honouring a possible opt-out is the safe side.
    if (route.intent === "opt_out") {
      await optOut("router_agent", replyLang);
      return { outcome: "opted_out", path, model: models };
    }
    if (route.confidence < CONFIDENCE_FLOOR) return await handoff("low_confidence");

    switch (route.intent) {
      case "complaint":
      case "sensitive":
      case "human_request":
      case "unclear":
        return await handoff(route.intent);
      case "off_topic":
        await send(FIXED_TEXT.offTopic[replyLang], "router");
        return { outcome: "off_topic", path, model: models };
    }

    let draft: string;
    let appendLink = false;
    let commit: () => void = () => {};
    let closes = false;

    if (route.intent === "enquiry") {
      const r: EnquiryResult = track("enquiry", await runEnquiry(llm, profile, ctx, route));
      if (r.needs_human) return await handoff(r.handoff_reason ?? "enquiry_needs_human");
      draft = r.reply;
    } else if (route.intent === "winback_reply" && ctx.isWinbackReply) {
      const r: RetentionResult = track("retention", await runRetention(llm, profile, ctx, route));
      db.prepare("INSERT INTO retention_reasons (client_id, reason, at) VALUES (?, ?, ?)").run(client.id, r.reason, iso);
      if (r.wants_no_more_messages) {
        await optOut("retention_agent", replyLang);
        return { outcome: "opted_out", path, model: models };
      }
      if (r.action === "handoff") return await handoff(`winback_${r.reason}`);
      draft = r.reply;
      appendLink = r.action === "offer_booking";
      closes = r.action === "close";
    } else if (route.intent === "winback_reply") {
      // Sounds like a win-back reply, but we haven't sent this person one recently.
      return await handoff("unexpected_winback_reply");
    } else {
      const r: BookingResult = track("booking", await runBooking(llm, profile, ctx, route));
      if (r.needs_human) return await handoff("booking_needs_human");
      draft = r.reply;
      appendLink = r.action === "send_booking_link";
      const type = { request_new: "new", request_reschedule: "reschedule", request_cancel: "cancel" }[
        r.action as "request_new" | "request_reschedule" | "request_cancel"
      ];
      if (type) {
        // A service id the model invented is dropped rather than saved.
        const service = profile.services.some((s) => s.id === r.service_id) ? r.service_id : null;
        commit = () => {
          db.prepare(
            "INSERT INTO booking_requests (client_id, type, service_id, preferred_time, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run(client.id, type, service, r.preferred_time, iso);
        };
      }
    }

    // 3. Guards: code first, since it is free and can't be persuaded.
    const rules = checkReply(draft, profile);
    path.push("guard_rules");
    if (!rules.ok) {
      audit(db, at, client.id, "guard_rules", "blocked", { violations: rules.violations, draft });
      return await handoff(`guard_rules:${rules.violations[0]}`);
    }
    if (deps.guardLlm !== false) {
      const review = track("guard", await runGuardReview(llm, profile, ctx, draft));
      if (!review.pass) {
        audit(db, at, client.id, "guard", "blocked", { issues: review.issues, draft });
        return await handoff("guard_review");
      }
    }

    // 4. Only now do side effects happen. Links and disclosure come from code.
    commit();
    const introduced = db
      .prepare("SELECT 1 FROM messages WHERE client_id = ? AND direction = 'out' AND kind = 'text' AND agent IN ('enquiry','booking','retention') LIMIT 1")
      .get(client.id);
    let body = fillName(draft, client.first_name);
    if (!introduced) body = FIXED_TEXT.disclosure[replyLang](profile.name) + body;
    if (appendLink) body += FIXED_TEXT.bookLink[replyLang](profile.booking_link);
    await send(body, route.intent === "enquiry" ? "enquiry" : route.intent === "winback_reply" ? "retention" : "booking");
    return { outcome: closes ? "closed" : "replied", path, reply: body, model: models };
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      audit(db, at, client.id, "orchestrator", "llm_unavailable", { reason: err.reason });
      return handoff(`llm_unavailable:${err.reason}`);
    }
    throw err;
  }
}
