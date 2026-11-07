import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleInbound, type Deps } from "../agents/orchestrator.ts";
import { ConsoleChannel } from "../channels/types.ts";
import type { SalonProfile } from "../config.ts";
import { audit, openDb, type DB } from "../db.ts";
import { seedWinback } from "../eval/live.ts";
import { importClients, importVisits } from "../import/csv.ts";
import { buildLlm, type ProviderFailure } from "../llm/build.ts";
import type { AttemptEvent } from "../llm/freeModels.ts";
import { StubLLM } from "../llm/stub.ts";
import type { LLM } from "../llm/types.ts";
import { redact } from "../privacy/redact.ts";
import { StaffError, closeHandoff, sendStaffReply } from "../staff/operations.ts";
import { createStaffHandler } from "../staff/server.ts";

/**
 * Local test page. Everything lives in an in-memory database and replies go to a
 * console channel, so nothing can reach WhatsApp and nothing survives a restart.
 */

const PHONE = "+971500000001";
const MAX_BODY = 100_000;

const PERSONAS = {
  new_lead: "New enquirer, no history",
  regular_en: "Regular client (English)",
  regular_ar: "Regular client (Arabic)",
  lapsed_en: "Lapsed client, just got a win-back (English)",
  lapsed_ar: "Lapsed client, just got a win-back (Arabic)",
} as const;
type Persona = keyof typeof PERSONAS;

const MODES = ["groq,openrouter", "groq", "openrouter", "stub"] as const;
type Mode = (typeof MODES)[number];

interface Trace {
  attempts: AttemptEvent[];
  failovers: ProviderFailure[];
}

export interface UiOptions {
  profile: SalonProfile;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, "Message too large"));
      else chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
  });
}

export function createUiHandler(options: UiOptions) {
  const { profile, env = process.env } = options;
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const keys = { groq: Boolean(env["GROQ_API_KEY"]), openrouter: Boolean(env["OPENROUTER_API_KEY"]) };

  let db: DB = openDb();
  let staffHandler = createStaffHandler({ db, profile, channel: new ConsoleChannel(true), basePath: "/staff" });
  let persona: Persona = "new_lead";
  let templatePreview: string | null = null;
  let simulateGroqLimit = false;
  let guardLlm = env["GUARD_LLM"] !== "off";
  let busy = false;
  let trace: Trace = { attempts: [], failovers: [] };
  const configured = env["LLM_PROVIDERS"]?.replace(/\s/g, "") as Mode | undefined;
  let mode: Mode = configured && MODES.includes(configured) ? configured : keys.groq && keys.openrouter ? "groq,openrouter" : keys.groq ? "groq" : keys.openrouter ? "openrouter" : "stub";
  let llm: LLM | null = null;
  let llmError: string | null = null;

  /** Stands in for a real Groq rate limit, so the handover can be seen on demand. */
  const testFetch: typeof fetch = async (input, init) => {
    if (simulateGroqLimit && String(input).includes("api.groq.com") && String(input).endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: "Simulated limit from the test page" } }), {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    return baseFetch(input, init);
  };

  function rebuildLlm(): void {
    llmError = null;
    if (mode === "stub") {
      llm = new StubLLM();
      return;
    }
    try {
      llm = buildLlm({
        env: { ...env, LLM_PROVIDERS: mode },
        fetchImpl: testFetch,
        onAttempt: (e) => {
          trace.attempts.push(e);
          audit(db, new Date(), null, "llm", e.outcome === "ok" ? "attempt_ok" : "attempt_failed", e);
        },
        onFailover: (f) => {
          trace.failovers.push(f);
          audit(db, new Date(), null, "llm", "provider_failover", f);
        },
      });
    } catch (err) {
      llm = null;
      llmError = err instanceof Error ? err.message : String(err);
    }
  }

  async function reset(next: Persona): Promise<void> {
    db.close();
    db = openDb();
    staffHandler = createStaffHandler({ db, profile, channel: new ConsoleChannel(true), basePath: "/staff" });
    persona = next;
    templatePreview = null;
    const now = new Date();
    const language = next.endsWith("_ar") ? "ar" : "en";
    const name = language === "ar" ? "Layla" : "Mona";
    if (next.startsWith("regular")) {
      const recent = new Date(now.getTime() - 20 * 86_400_000).toISOString().slice(0, 10);
      const service = profile.services[0]!;
      importClients(db, `client_id,first_name,phone,language,whatsapp_marketing_consent,consent_source\nu1,${name},${PHONE},${language},yes,test_page\n`, now);
      importVisits(db, `client_id,service,date,amount_aed,status\nu1,${service.name_en},${recent},${service.price_aed},completed\n`, now);
    }
    if (next.startsWith("lapsed")) {
      await seedWinback(db, profile, PHONE, name, language);
      const row = db.prepare("SELECT service_label FROM campaign_assignments LIMIT 1").get() as { service_label: string | null } | undefined;
      const service = profile.services.find((s) => s.id === row?.service_label);
      const tpl = profile.templates.winback[language];
      templatePreview = tpl.preview
        .replace("{{1}}", name)
        .replace("{{2}}", (language === "ar" ? service?.name_ar : service?.name_en) ?? "")
        .replace("{{3}}", profile.booking_link);
    }
  }

  function state() {
    const client = db.prepare("SELECT id, first_name, marketing_opt_in, opted_out_at FROM clients WHERE phone = ?").get(PHONE) as
      | { id: string; first_name: string | null; marketing_opt_in: number; opted_out_at: string | null }
      | undefined;
    const messages = client
      ? (db.prepare("SELECT direction, body, kind, agent FROM messages WHERE client_id = ? ORDER BY id").all(client.id) as unknown as { direction: string; body: string; kind: string; agent: string | null }[])
      : [];
    return {
      salon: profile.name,
      persona,
      personas: PERSONAS,
      mode,
      keys,
      simulateGroqLimit,
      guardLlm,
      error: llmError,
      client: {
        id: client?.id ?? null,
        name: client?.first_name ?? null,
        consent: !client ? "none yet" : client.opted_out_at ? "opted out" : client.marketing_opt_in ? "opted in" : "not given",
      },
      messages: messages.map((m) => (m.kind === "template" && templatePreview ? { ...m, body: templatePreview } : m)),
      handoffs: db.prepare("SELECT id, reason, summary FROM handoffs WHERE status = 'open' ORDER BY id").all(),
      requests: db.prepare("SELECT id, type, service_id, preferred_time FROM booking_requests WHERE status = 'pending' ORDER BY id").all(),
    };
  }

  async function sendMessage(body: Record<string, unknown>) {
    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    const kind = body["kind"] === "other" ? "other" : "text";
    if (!text) throw new HttpError(400, "Type a message first");
    if (text.length > 2000) throw new HttpError(400, "Message too long");
    if (!llm) throw new HttpError(400, llmError ?? "No model is set up");
    if (busy) throw new HttpError(409, "Still working on the last message");
    busy = true;
    trace = { attempts: [], failovers: [] };
    const started = Date.now();
    try {
      const auditFrom = (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit").get() as { n: number }).n;
      const firstName = (db.prepare("SELECT first_name FROM clients WHERE phone = ?").get(PHONE) as { first_name: string | null } | undefined)?.first_name;
      const deps: Deps = { db, profile, llm, channel: new ConsoleChannel(true), now: () => new Date(), guardLlm };
      const result = await handleInbound(deps, { from: PHONE, text, kind });
      const blocked = (db.prepare("SELECT actor, detail FROM audit WHERE id > ? AND action = 'blocked' ORDER BY id").all(auditFrom) as unknown as { actor: string; detail: string }[]).map((b) => ({
        actor: b.actor,
        ...(JSON.parse(b.detail) as { draft?: string; violations?: string[]; issues?: string[] }),
      }));
      return {
        turn: {
          ...result,
          ms: Date.now() - started,
          attempts: trace.attempts,
          failovers: trace.failovers,
          blocked,
          modelSaw: redact(text, firstName),
          stub: mode === "stub",
        },
        state: state(),
      };
    } finally {
      busy = false;
    }
  }

  async function route(req: IncomingMessage, url: URL): Promise<unknown> {
    if (req.method === "GET" && url.pathname === "/api/state") return state();
    if (req.method !== "POST") throw new HttpError(404, "Not found");
    // A web page on another site can't send this content type without permission.
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON only");
    const body = await readJson(req);
    switch (url.pathname) {
      case "/api/message":
        return sendMessage(body);
      case "/api/reset": {
        if (busy) throw new HttpError(409, "Still working on the last message");
        const next = (body["persona"] ?? persona) as string;
        if (!(next in PERSONAS)) throw new HttpError(400, "Unknown client type");
        await reset(next as Persona);
        return state();
      }
      case "/api/settings": {
        if (busy) throw new HttpError(409, "Still working on the last message");
        if (typeof body["mode"] === "string") {
          if (!MODES.includes(body["mode"] as Mode)) throw new HttpError(400, "Unknown model setting");
          mode = body["mode"] as Mode;
        }
        if (typeof body["simulateGroqLimit"] === "boolean") simulateGroqLimit = body["simulateGroqLimit"];
        if (typeof body["guardLlm"] === "boolean") guardLlm = body["guardLlm"];
        rebuildLlm(); // Also clears benched models, so switching the simulation off takes effect now.
        return state();
      }
      case "/api/close-handoff":
        if (busy) throw new HttpError(409, "Still working on the last message");
        closeHandoff(db, body["id"]);
        return state();
      case "/api/staff-reply": {
        if (busy) throw new HttpError(409, "Still working on the last message");
        const client = db.prepare("SELECT id FROM clients WHERE phone = ?").get(PHONE) as { id: string } | undefined;
        if (!client) throw new HttpError(404, "Send a customer message first");
        await sendStaffReply(db, new ConsoleChannel(true), client.id, body["text"]);
        return state();
      }
      default:
        throw new HttpError(404, "Not found");
    }
  }

  rebuildLlm();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/staff" || url.pathname.startsWith("/staff/")) {
      if (busy && req.method === "POST") {
        res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Still working on the last message" }));
        return;
      }
      return staffHandler(req, res);
    }
    // Blocks other sites from reaching this server through a rebound DNS name.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "localhost" && host !== "127.0.0.1") {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      res.end(html);
      return;
    }
    try {
      const result = await route(req, url);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError || err instanceof StaffError ? err.status : 500;
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err instanceof Error ? err.message : "Something went wrong" }));
    }
  };
}
