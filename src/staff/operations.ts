import type { Channel } from "../channels/types.ts";
import type { SalonProfile } from "../config.ts";
import { audit, type DB } from "../db.ts";

export class StaffError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function id(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new StaffError(400, "Invalid ID");
  return n;
}

function service(profile: SalonProfile, value: unknown): string {
  if (typeof value !== "string" || !profile.services.some((s) => s.id === value)) {
    throw new StaffError(400, "Unknown service");
  }
  return value;
}

export function effectiveProfile(db: DB, profile: SalonProfile): SalonProfile {
  const overrides = new Map(
    (db.prepare("SELECT service_id, price_aed FROM service_prices").all() as { service_id: string; price_aed: number }[])
      .map((row) => [row.service_id, row.price_aed]),
  );
  return { ...profile, services: profile.services.map((s) => ({ ...s, price_aed: overrides.get(s.id) ?? s.price_aed })) };
}

export function dashboardState(db: DB, profile: SalonProfile) {
  return {
    salon: profile.name,
    timezone: profile.timezone,
    services: effectiveProfile(db, profile).services.map((s) => ({
      id: s.id, name_en: s.name_en, name_ar: s.name_ar, price_aed: s.price_aed,
      default_price_aed: profile.services.find((base) => base.id === s.id)!.price_aed,
      duration_min: s.duration_min,
    })),
    conversations: db.prepare(`
      SELECT c.id, c.first_name, c.phone, c.language, c.opted_out_at,
        MAX(m.id) AS last_message_id,
        (SELECT body FROM messages WHERE client_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT id FROM handoffs WHERE client_id = c.id AND status = 'open' ORDER BY id DESC LIMIT 1) AS handoff_id
      FROM clients c JOIN messages m ON m.client_id = c.id
      GROUP BY c.id ORDER BY last_message_id DESC LIMIT 100
    `).all(),
    handoffs: db.prepare(`
      SELECT h.id, h.client_id, h.reason, h.summary, h.created_at, c.first_name, c.phone
      FROM handoffs h JOIN clients c ON c.id = h.client_id
      WHERE h.status = 'open' ORDER BY h.id DESC
    `).all(),
    requests: db.prepare(`
      SELECT b.id, b.client_id, b.type, b.service_id, b.preferred_time, b.slot_id, b.status, b.created_at,
        c.first_name, c.phone FROM booking_requests b JOIN clients c ON c.id = b.client_id
      ORDER BY b.id DESC LIMIT 100
    `).all(),
    slots: db.prepare("SELECT id, service_id, starts_at, ends_at, status FROM availability_slots ORDER BY starts_at, id LIMIT 500").all(),
    appointments: db.prepare(`
      SELECT a.id, a.client_id, a.request_id, a.service_id, a.starts_at, a.ends_at, a.external_entered_at,
        c.first_name, c.phone FROM appointments a JOIN clients c ON c.id = a.client_id
      ORDER BY a.starts_at DESC LIMIT 100
    `).all(),
  };
}

export function conversation(db: DB, clientId: string) {
  const client = db.prepare("SELECT id, first_name, phone, language FROM clients WHERE id = ?").get(clientId);
  if (!client) throw new StaffError(404, "Conversation not found");
  const messages = db.prepare("SELECT id, direction, body, kind, agent, at FROM messages WHERE client_id = ? ORDER BY id DESC LIMIT 100").all(clientId);
  return { client, messages: messages.reverse() };
}

export async function sendStaffReply(db: DB, channel: Channel, clientId: string, text: unknown, now = new Date()): Promise<void> {
  const body = typeof text === "string" ? text.trim() : "";
  if (!body || body.length > 2000) throw new StaffError(400, "Reply must be 1 to 2000 characters");
  const client = db.prepare("SELECT id, phone FROM clients WHERE id = ?").get(clientId) as { id: string; phone: string } | undefined;
  if (!client) throw new StaffError(404, "Conversation not found");
  const open = db.prepare("SELECT id FROM handoffs WHERE client_id = ? AND status = 'open' LIMIT 1").get(clientId);
  if (!open) {
    db.prepare("INSERT INTO handoffs (client_id, reason, summary, created_at) VALUES (?, 'staff_takeover', 'Staff replied directly', ?)")
      .run(clientId, now.toISOString());
  }
  const providerId = await channel.sendText(client.phone, body);
  db.prepare("INSERT INTO messages (client_id, direction, body, kind, provider_id, agent, at) VALUES (?, 'out', ?, 'text', ?, 'staff', ?)")
    .run(clientId, body, providerId, now.toISOString());
  audit(db, now, clientId, "staff", "replied", { message_id: providerId });
}

export function closeHandoff(db: DB, value: unknown, now = new Date()): void {
  const handoffId = id(value);
  const row = db.prepare("SELECT client_id FROM handoffs WHERE id = ? AND status = 'open'").get(handoffId) as { client_id: string } | undefined;
  if (!row) throw new StaffError(404, "Open handoff not found");
  db.prepare("UPDATE handoffs SET status = 'closed', closed_at = ? WHERE id = ?").run(now.toISOString(), handoffId);
  audit(db, now, row.client_id, "staff", "closed_handoff", { id: handoffId });
}

export function setPrice(db: DB, profile: SalonProfile, serviceId: unknown, value: unknown, now = new Date()): void {
  const name = service(profile, serviceId);
  const price = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000 || Math.abs(Math.round(price * 100) - price * 100) > 0.000001) {
    throw new StaffError(400, "Enter a valid AED price with up to two decimals");
  }
  db.prepare(`INSERT INTO service_prices (service_id, price_aed, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(service_id) DO UPDATE SET price_aed = excluded.price_aed, updated_at = excluded.updated_at`)
    .run(name, price, now.toISOString());
  audit(db, now, null, "staff", "price_updated", { service_id: name, price_aed: price });
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
function validLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value) && Number.isFinite(Date.parse(value + "Z")) && new Date(value + "Z").toISOString().slice(0, 16) === value;
}
export function addSlot(db: DB, profile: SalonProfile, serviceId: unknown, start: unknown, end: unknown, now = new Date()): void {
  const name = service(profile, serviceId);
  if (typeof start !== "string" || typeof end !== "string" || !validLocalTime(start) || !validLocalTime(end) || end <= start) {
    throw new StaffError(400, "Enter a valid start and end time in salon local time");
  }
  const duration = profile.services.find(s => s.id === name)!.duration_min;
  if ((Date.parse(end + "Z") - Date.parse(start + "Z")) / 60_000 < duration) {
    throw new StaffError(400, `This service needs at least ${duration} minutes`);
  }
  try {
    db.prepare("INSERT INTO availability_slots (service_id, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?)")
      .run(name, start, end, now.toISOString());
  } catch {
    throw new StaffError(409, "That availability slot already exists");
  }
  audit(db, now, null, "staff", "slot_added", { service_id: name, starts_at: start, ends_at: end });
}

export function removeSlot(db: DB, value: unknown, now = new Date()): void {
  const slotId = id(value);
  const row = db.prepare("SELECT service_id, starts_at FROM availability_slots WHERE id = ? AND status = 'available'").get(slotId);
  if (!row) throw new StaffError(404, "Available slot not found");
  db.prepare("DELETE FROM availability_slots WHERE id = ?").run(slotId);
  audit(db, now, null, "staff", "slot_removed", { id: slotId });
}

export function resolveRequest(db: DB, value: unknown, status: unknown, now = new Date()): void {
  const requestId = id(value);
  if (status !== "done" && status !== "declined") throw new StaffError(400, "Unknown request status");
  const row = db.prepare("SELECT client_id FROM booking_requests WHERE id = ? AND status = 'pending'").get(requestId) as { client_id: string } | undefined;
  if (!row) throw new StaffError(404, "Pending request not found");
  db.prepare("UPDATE booking_requests SET status = ? WHERE id = ?").run(status, requestId);
  audit(db, now, row.client_id, "staff", "request_resolved", { id: requestId, status });
}

/** WhatsApp only allows free-text replies within 24 hours of the customer's last message. */
export function replyWindowOpen(db: DB, clientId: string, now = new Date()): boolean {
  const last = db.prepare("SELECT MAX(at) AS at FROM messages WHERE client_id = ? AND direction = 'in'").get(clientId) as { at: string | null };
  return Boolean(last.at) && Number.isFinite(Date.parse(last.at!)) && now.getTime() - Date.parse(last.at!) < 86_400_000;
}

/** Tells the customer their booking is confirmed. The booking stands even if the message can't go out. */
export async function notifyBookingConfirmed(db: DB, channel: Channel, profile: SalonProfile, appointmentId: number, now = new Date()): Promise<string> {
  const a = db.prepare(`SELECT a.client_id, a.service_id, a.starts_at, c.phone, c.language
    FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.id = ?`).get(appointmentId) as
    { client_id: string; service_id: string; starts_at: string; phone: string; language: string };
  if (channel.mode === "whatsapp" && !replyWindowOpen(db, a.client_id, now)) {
    return "Booking recorded. The customer wasn't messaged because the 24-hour WhatsApp window is closed, so let them know another way.";
  }
  const ar = a.language === "ar";
  const s = profile.services.find((x) => x.id === a.service_id);
  // Slot times are salon local time, so format them as-is rather than converting.
  const when = new Intl.DateTimeFormat(ar ? "ar-AE-u-nu-latn" : "en-GB", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }).format(new Date(a.starts_at + "Z"));
  const body = ar
    ? `تم تأكيد موعد ${s?.name_ar ?? "خدمتك"} في ${profile.name} يوم ${when}. إذا أردت التغيير، راسلنا هنا.`
    : `Your ${s?.name_en ?? "appointment"} at ${profile.name} is confirmed for ${when}. Reply here if you need to change it.`;
  try {
    const providerId = await channel.sendText(a.phone, body);
    db.prepare("INSERT INTO messages (client_id, direction, body, kind, provider_id, agent, at) VALUES (?, 'out', ?, 'text', ?, 'booking_confirmation', ?)")
      .run(a.client_id, body, providerId, now.toISOString());
    audit(db, now, a.client_id, "staff", "booking_confirmation_sent", { appointment_id: appointmentId });
    return "Booking recorded and the customer was sent a confirmation.";
  } catch {
    audit(db, now, a.client_id, "staff", "booking_confirmation_failed", { appointment_id: appointmentId });
    return "Booking recorded, but the confirmation message couldn't be sent. Message the customer from the inbox.";
  }
}

export function markEnteredElsewhere(db: DB, value: unknown, now = new Date()): void {
  const appointmentId = id(value);
  const r = db.prepare("UPDATE appointments SET external_entered_at = ? WHERE id = ? AND external_entered_at IS NULL").run(now.toISOString(), appointmentId);
  if (!r.changes) throw new StaffError(404, "Appointment not found or already marked");
  audit(db, now, null, "staff", "appointment_entered_elsewhere", { id: appointmentId });
}

export function confirmBooking(db: DB, requestValue: unknown, slotValue: unknown, now = new Date()): number {
  const requestId = id(requestValue);
  const slotId = id(slotValue);
  db.exec("BEGIN IMMEDIATE");
  try {
    const request = db.prepare("SELECT client_id, type, service_id FROM booking_requests WHERE id = ? AND status = 'pending'").get(requestId) as
      | { client_id: string; type: string; service_id: string | null } | undefined;
    const slot = db.prepare("SELECT service_id, starts_at, ends_at FROM availability_slots WHERE id = ? AND status = 'available'").get(slotId) as
      | { service_id: string; starts_at: string; ends_at: string } | undefined;
    if (!request || request.type !== "new") throw new StaffError(404, "Pending new booking request not found");
    if (!slot) throw new StaffError(404, "Available slot not found");
    if (request.service_id && request.service_id !== slot.service_id) throw new StaffError(400, "Slot service does not match the request");
    db.prepare("UPDATE availability_slots SET status = 'booked' WHERE id = ?").run(slotId);
    const appointment = db.prepare("INSERT INTO appointments (client_id, request_id, slot_id, service_id, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(request.client_id, requestId, slotId, slot.service_id, slot.starts_at, slot.ends_at, now.toISOString());
    db.prepare("UPDATE booking_requests SET status = 'done' WHERE id = ?").run(requestId);
    audit(db, now, request.client_id, "staff", "booking_recorded", { request_id: requestId, slot_id: slotId });
    db.exec("COMMIT");
    return Number(appointment.lastInsertRowid);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
