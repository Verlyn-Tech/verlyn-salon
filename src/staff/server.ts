import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel } from "../channels/types.ts";
import type { SalonProfile } from "../config.ts";
import type { DB } from "../db.ts";
import {
  StaffError, addSlot, closeHandoff, confirmBooking, conversation, dashboardState,
  removeSlot, resolveRequest, sendStaffReply, setPrice,
} from "./operations.ts";

export interface StaffOptions {
  db: DB;
  profile: SalonProfile;
  channel: Channel;
  basePath?: string;
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
export function createStaffHandler({ db, profile, channel, basePath = "" }: StaffOptions) {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8").replaceAll("__API_BASE__", basePath);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "";
    const hostname = host.replace(/:\d+$/, "");
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
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
      if (req.method === "GET" && url.pathname === "/api/state") result = dashboardState(db, profile);
      else if (req.method === "GET" && url.pathname === "/api/conversation") result = conversation(db, url.searchParams.get("client") ?? "");
      else if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) throw new StaffError(415, "JSON only");
        const body = await readJson(req);
        switch (url.pathname) {
          case "/api/reply":
            await sendStaffReply(db, channel, String(body.clientId ?? ""), body.text);
            break;
          case "/api/close-handoff": closeHandoff(db, body.id); break;
          case "/api/price": setPrice(db, profile, body.serviceId, body.price); break;
          case "/api/slot": addSlot(db, profile, body.serviceId, body.start, body.end); break;
          case "/api/remove-slot": removeSlot(db, body.id); break;
          case "/api/resolve-request": resolveRequest(db, body.id, body.status); break;
          case "/api/confirm-booking": confirmBooking(db, body.requestId, body.slotId); break;
          default: throw new StaffError(404, "Not found");
        }
        result = dashboardState(db, profile);
      } else throw new StaffError(404, "Not found");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof StaffError ? err.status : 500;
      const message = err instanceof StaffError ? err.message : "Unexpected server error";
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
    }
  };
}
