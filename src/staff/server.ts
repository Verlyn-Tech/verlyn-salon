import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel } from "../channels/types.ts";
import type { SalonProfile } from "../config.ts";
import type { DB } from "../db.ts";
import {
  StaffError, addSlot, closeHandoff, confirmBooking, conversation, dashboardState, markEnteredElsewhere,
  notifyBookingConfirmed, removeSlot, replyWindowOpen, resolveRequest, sendStaffReply, setPrice,
} from "./operations.ts";

export interface StaffOptions {
  db: DB;
  profile: SalonProfile;
  channel: Channel;
  basePath?: string;
  runExclusive?: <T>(task: () => Promise<T>) => Promise<T>;
  /** When set, the dashboard asks for this password and may be reached through an HTTPS tunnel. */
  password?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Browser sign-in (HTTP Basic). Any username; only the password is checked. */
function signedIn(header: string | undefined, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  return decoded.includes(":") && timingSafeEqual(digest(given), digest(password));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > 10_000) throw new StaffError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON object");
    return body as Record<string, unknown>;
  } catch {
    throw new StaffError(400, "Invalid JSON");
  }
}

/** Local staff dashboard. The channel is injected so replies can be dry-run now and sent later. */
export function createStaffHandler({ db, profile, channel, basePath = "", runExclusive, password }: StaffOptions) {
  if (password !== undefined && password.length < 12) throw new Error("DASHBOARD_PASSWORD must be at least 12 characters");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8").replaceAll("__API_BASE__", basePath);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "";
    const hostname = host.replace(/:\d+$/, "");
    if (password) {
      if (!signedIn(req.headers.authorization, password)) {
        await new Promise((r) => setTimeout(r, 1000)); // slows password guessing
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Rebook staff", charset="UTF-8"' }).end();
        return;
      }
    } else if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      res.writeHead(403).end();
      return;
    }
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== host) throw new Error("Wrong origin");
      } catch {
        res.writeHead(403).end();
        return;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (basePath) url.pathname = url.pathname.slice(basePath.length) || "/";
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      }).end(html);
      return;
    }
    try {
      let result: unknown;
      let notice: string | undefined;
      if (req.method === "GET" && url.pathname === "/api/state") result = { ...dashboardState(db, profile), channel: channel.mode ?? "console" };
      else if (req.method === "GET" && url.pathname === "/api/conversation") result = conversation(db, url.searchParams.get("client") ?? "");
      else if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) throw new StaffError(415, "JSON only");
        const body = await readJson(req);
        const mutate = async () => {
        switch (url.pathname) {
          case "/api/reply":
            if (channel.mode === "whatsapp" && !replyWindowOpen(db, String(body.clientId ?? ""))) {
              throw new StaffError(409, "The 24-hour WhatsApp reply window is closed. Ask the customer to message again, or use an approved template.");
            }
            try {
            await sendStaffReply(db, channel, String(body.clientId ?? ""), body.text);
            } catch (err) {
              if (err instanceof StaffError) throw err;
              throw new StaffError(502, "WhatsApp could not accept the reply. It was not saved as sent. Check the token, recipient access and reply window before trying again.");
            }
            break;
          case "/api/close-handoff": closeHandoff(db, body.id); break;
          case "/api/price": setPrice(db, profile, body.serviceId, body.price); break;
          case "/api/slot": addSlot(db, profile, body.serviceId, body.start, body.end); break;
          case "/api/remove-slot": removeSlot(db, body.id); break;
          case "/api/resolve-request": resolveRequest(db, body.id, body.status); break;
          case "/api/confirm-booking":
            notice = await notifyBookingConfirmed(db, channel, profile, confirmBooking(db, body.requestId, body.slotId));
            break;
          case "/api/mark-entered": markEnteredElsewhere(db, body.id); break;
          default: throw new StaffError(404, "Not found");
        }
        };
        if (runExclusive) await runExclusive(mutate);
        else await mutate();
        result = { ...dashboardState(db, profile), channel: channel.mode ?? "console", notice };
      } else throw new StaffError(404, "Not found");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof StaffError ? err.status : 500;
      const message = err instanceof StaffError ? err.message : "Unexpected server error";
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
    }
  };
}
