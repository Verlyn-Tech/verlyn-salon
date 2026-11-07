import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { handleInbound, type Deps } from "./agents/orchestrator.ts";
import { createWebhookHandler } from "./channels/server.ts";
import { ConsoleChannel, type Channel } from "./channels/types.ts";
import { WhatsAppChannel } from "./channels/whatsapp.ts";
import { loadEnv, loadProfile, type SalonProfile } from "./config.ts";
import { audit, openDb, type DB } from "./db.ts";
import { sampleData, seededRandom } from "./demo/sample.ts";
import { LIVE_CASES, runLiveEval } from "./eval/live.ts";
import { importClients, importVisits } from "./import/csv.ts";
import { buildLlm } from "./llm/build.ts";
import { FreeModelRouter, groqProvider } from "./llm/freeModels.ts";
import { StubLLM } from "./llm/stub.ts";
import type { LLM } from "./llm/types.ts";
import { computePilot, ownerSummary, renderReport } from "./report/pilot.ts";
import { buildCampaign, sendCampaign } from "./retention/campaign.ts";
import { createUiHandler } from "./ui/server.ts";
import { createStaffHandler } from "./staff/server.ts";

const HELP = `Verlyn Rebook

  npm run rebook -- <command>

Try it
  ui                           Test page in your browser, on this computer only
  demo                         Full pilot on fictional data, no API key needed
  sim [--stub]                 Chat with the agents. --stub needs no API key
  models                       List the free models available right now
  eval [--limit N]             Test the real free models on synthetic messages

Run a pilot
  sample                       Write fictional CSVs to data/
  import <clients> <visits>    Import CSV exports
  campaign build <id>          Pick overdue clients and split off the control group
  campaign send <id> [--limit N] [--live]
                               Preview only unless --live is passed
  report <id> [--no-ai]        Write results to reports/<id>.md
  queue                        Show staff handoffs and booking requests
  close <handoff-id>           Give a conversation back to the assistant
  dashboard                    Local staff inbox, bookings, availability and pricing

Go live
  server [--dry]               WhatsApp webhook. --dry prints replies instead of sending
`;

function freeModels(db?: DB, verbose = false) {
  return buildLlm({
    onAttempt: (e) => {
      if (verbose && e.outcome !== "ok") console.error(`[models] ${e.agent}: ${e.model} failed: ${e.outcome}`);
      if (db) audit(db, new Date(), null, "llm", e.outcome === "ok" ? "attempt_ok" : "attempt_failed", e);
    },
    onFailover: (f) => {
      console.error(`[models] ${f.provider} unavailable (${f.reason}), trying the next provider`);
      if (db) audit(db, new Date(), null, "llm", "provider_failover", f);
    },
  });
}

function liveChannel(): WhatsAppChannel {
  return new WhatsAppChannel({
    token: process.env["WHATSAPP_TOKEN"] ?? "",
    phoneNumberId: process.env["WHATSAPP_PHONE_NUMBER_ID"] ?? "",
    graphVersion: process.env["WHATSAPP_GRAPH_VERSION"] ?? "v23.0",
  });
}

const guardOn = () => process.env["GUARD_LLM"] !== "off";

async function simulator(profile: SalonProfile, stub: boolean): Promise<void> {
  const db = openDb();
  const llm: LLM = stub ? new StubLLM() : freeModels(db);
  const deps: Deps = { db, profile, llm, channel: new ConsoleChannel(), now: () => new Date(), guardLlm: guardOn() };
  console.log(`Chatting as a customer of ${profile.name}. Nothing is sent to WhatsApp and nothing is saved.`);
  console.log(stub ? "STUB MODE: keyword rules, not AI.\n" : "Using free models. Use only made-up details.\n");
  console.log("Type a message. /close hands the conversation back after a handoff, /quit exits.\n");
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === "/quit") break;
    if (text === "/close") {
      db.prepare("UPDATE handoffs SET status = 'closed' WHERE status = 'open'").run();
      console.log("(handoff closed)\n");
      continue;
    }
    const r = await handleInbound(deps, { from: "+971500000001", text });
    console.log(`(${r.outcome}${r.reason ? `: ${r.reason}` : ""} | ${r.path.join(" > ")}${r.model?.length ? ` | ${[...new Set(r.model)].join(", ")}` : ""})\n`);
  }
}

async function demo(profile: SalonProfile): Promise<void> {
  const banner = "SYNTHETIC DEMO. Fictional clients, a keyword stub instead of AI, and made-up rebooking rates. Not a result to quote.";
  console.log(`${banner}\n`);
  const db = openDb();
  const start = new Date("2026-11-07T08:00:00Z");
  const { clients, visits } = sampleData(profile, start);
  const ci = importClients(db, clients, start);
  importVisits(db, visits, start);
  console.log(`1. Imported ${ci.imported} clients, ${ci.consented} with WhatsApp marketing consent.`);

  const f = buildCampaign(db, profile, "demo", start);
  console.log(`2. Eligible: ${f.eligible} (no consent ${f.no_consent}, not overdue ${f.not_overdue}, too lapsed ${f.too_lapsed}). Treatment ${f.treatment}, control ${f.control}.`);

  const channel = new ConsoleChannel(true);
  const sent = await sendCampaign(db, profile, channel, "demo", { now: start, limit: 10_000 });
  console.log(`3. Sent ${sent.sent} win-back templates to the treatment group and none to control.`);

  const first = db.prepare(
    `SELECT c.phone FROM campaign_assignments a JOIN clients c ON c.id = a.client_id WHERE a.arm = 'treatment' AND a.sent_at IS NOT NULL LIMIT 4`,
  ).all() as unknown as { phone: string }[];
  const deps: Deps = { db, profile, llm: new StubLLM(), channel, now: () => start };
  const conversations = [
    [first[0]?.phone, "Oh I forgot! Can I book?"],
    [first[1]?.phone, "I moved to Dubai sorry"],
    [first[2]?.phone, "STOP"],
    [first[3]?.phone, "I had a rash after my last colour"],
    ["+971500009999", "How much is a root colour?"],
  ] as const;
  console.log("4. Sample conversations:");
  for (const [from, text] of conversations) {
    if (!from) continue;
    const before = channel.sent.length;
    const r = await handleInbound(deps, { from, text });
    console.log(`\n   Customer: ${text}\n   Route:    ${r.path.join(" > ")} => ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`);
    if (channel.sent.length > before) console.log(`   Reply:    ${channel.sent.at(-1)?.body.replaceAll("\n", " ")}`);
  }

  // Made-up outcomes, so the report has something to show.
  const later = new Date(start.getTime() + 31 * 86_400_000);
  const rand = seededRandom(7);
  const rows = db.prepare("SELECT client_id, arm, service_label FROM campaign_assignments WHERE campaign_id = 'demo'").all() as unknown as { client_id: string; arm: string; service_label: string | null }[];
  const insert = db.prepare("INSERT INTO visits (client_id, service, visited_at, amount_aed, status) VALUES (?, ?, ?, ?, 'completed')");
  for (const r of rows) {
    if (rand() < (r.arm === "treatment" ? 0.22 : 0.06)) {
      const service = profile.services.find((s) => s.id === r.service_label);
      const date = new Date(start.getTime() + (3 + Math.floor(rand() * 25)) * 86_400_000).toISOString().slice(0, 10);
      insert.run(r.client_id, service?.name_en ?? "Visit", date, service?.price_aed ?? 150);
    }
  }
  const report = computePilot(db, profile, "demo", later);
  const { text } = await ownerSummary(null, report);
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/demo.md", renderReport(profile, report, text, banner));
  console.log(`\n5. ${text}\n\nFull report: reports/demo.md`);
}

async function main(): Promise<void> {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      stub: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      dry: { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      limit: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) return void console.log(HELP);

  const profile = loadProfile(process.env["SALON_PROFILE"] ?? "config/salon.example.json");
  const open = () => openDb(process.env["DB_PATH"] ?? "rebook.db");
  const limit = values.limit ? Number(values.limit) : undefined;

  switch (command) {
    case "dashboard": {
      const port = Number(process.env["DASHBOARD_PORT"] ?? 3200);
      const db = open();
      const handler = createStaffHandler({ db, profile, channel: new ConsoleChannel() });
      createServer((req, res) => void handler(req, res)).listen(port, "127.0.0.1", () => {
        console.log(`Staff dashboard: http://localhost:${port}\nLocal dry run: replies are saved and printed here, not sent to WhatsApp.\nPress Ctrl+C to stop.`);
      });
      return;
    }
    case "ui": {
      const port = Number(process.env["UI_PORT"] ?? 3100);
      const handler = createUiHandler({ profile });
      createServer((req, res) => void handler(req, res)).listen(port, "127.0.0.1", () => {
        console.log(`Test page: http://localhost:${port}\nPress Ctrl+C to stop.`);
      });
      return;
    }
    case "demo":
      return demo(profile);
    case "sim":
      return simulator(profile, values.stub);
    case "models": {
      const groqKey = process.env["GROQ_API_KEY"];
      if (groqKey) {
        const groq = await new FreeModelRouter({ apiKey: groqKey, provider: groqProvider() }).listFreeModels();
        console.log(`Groq, ${groq.length} permitted models:\n`);
        for (const m of groq) console.log(`  ${m.id}`);
      } else console.log("Groq: add GROQ_API_KEY to .env to list its models.");
      // OpenRouter's model list is public, so this works before a key is set.
      const models = await new FreeModelRouter({ apiKey: process.env["OPENROUTER_API_KEY"] || "not-needed-for-listing" }).listFreeModels();
      console.log(`\nOpenRouter, ${models.length} free text models:\n`);
      for (const m of models) console.log(`  ${m.id}${m.jsonMode ? "  (JSON mode)" : ""}`);
      return;
    }
    case "eval": {
      const cases = LIVE_CASES.slice(0, limit ?? LIVE_CASES.length);
      const llm = freeModels(undefined, true);
      console.log(`Running ${cases.length} synthetic messages through ${llm.names.join(", then ")}. Allow up to ${cases.length * 3} requests, plus any retries.\n`);
      const results = await runLiveEval(llm, profile, cases);
      for (const r of results) {
        console.log(`${r.verdict.toUpperCase().padEnd(12)} ${r.name} => ${r.outcome}${r.reason ? ` (${r.reason})` : ""}\n  models: ${[...new Set(r.models)].join(", ") || "none"}\n  reply: ${r.reply.replaceAll("\n", " ").slice(0, 400)}\n`);
      }
      const n = (v: string) => results.filter((r) => r.verdict === v).length;
      console.log(`pass ${n("pass")}, safe handoff ${n("safe_handoff")}, fail ${n("fail")} of ${results.length}`);
      if (n("fail")) process.exitCode = 1;
      return;
    }
    case "sample": {
      mkdirSync("data", { recursive: true });
      const { clients, visits } = sampleData(profile, new Date());
      writeFileSync("data/sample-clients.csv", clients);
      writeFileSync("data/sample-visits.csv", visits);
      console.log("Wrote data/sample-clients.csv and data/sample-visits.csv (fictional).");
      return;
    }
    case "import": {
      const [clientsPath, visitsPath] = args;
      if (!clientsPath || !visitsPath) throw new Error("Usage: import <clients.csv> <visits.csv>");
      const db = open();
      const c = importClients(db, readFileSync(clientsPath, "utf8"), new Date());
      const v = importVisits(db, readFileSync(visitsPath, "utf8"), new Date());
      console.log(`Clients: ${c.imported} of ${c.rows} imported, ${c.consented} with consent.`);
      console.log(`Visits: ${v.imported} of ${v.rows} imported.`);
      for (const r of [...c.rejected, ...v.rejected].slice(0, 20)) console.log(`  rejected row ${r.row}: ${r.reason}`);
      return;
    }
    case "campaign": {
      const [action, id] = args;
      if (!id || (action !== "build" && action !== "send")) throw new Error("Usage: campaign build|send <id>");
      const db = open();
      if (action === "build") return void console.log(buildCampaign(db, profile, id, new Date()));
      if (values.live) {
        return void console.log(await sendCampaign(db, profile, liveChannel(), id, { now: new Date(), ...(limit ? { limit } : {}) }));
      }
      // A preview runs the real logic, then undoes it, so clients aren't marked as sent.
      db.exec("BEGIN");
      try {
        const channel: Channel = new ConsoleChannel();
        console.log(await sendCampaign(db, profile, channel, id, { now: new Date(), limit: limit ?? 5 }));
      } finally {
        db.exec("ROLLBACK");
      }
      console.log("Preview only. Nothing was sent or saved. Add --live to send for real.");
      return;
    }
    case "report": {
      const [id] = args;
      if (!id) throw new Error("Usage: report <id>");
      const db = open();
      const report = computePilot(db, profile, id, new Date());
      const { text, source } = await ownerSummary(values["no-ai"] ? null : freeModels(db), report);
      mkdirSync("reports", { recursive: true });
      writeFileSync(`reports/${id}.md`, renderReport(profile, report, text));
      console.log(`${text}\n\nSummary written by: ${source}. Full report: reports/${id}.md`);
      return;
    }
    case "queue": {
      const db = open();
      console.table(db.prepare(
        `SELECT h.id, c.first_name AS name, c.phone, h.reason, h.summary, h.created_at FROM handoffs h
         JOIN clients c ON c.id = h.client_id WHERE h.status = 'open' ORDER BY h.id`,
      ).all());
      console.table(db.prepare(
        `SELECT b.id, c.first_name AS name, c.phone, b.type, b.service_id, b.preferred_time, b.created_at FROM booking_requests b
         JOIN clients c ON c.id = b.client_id WHERE b.status = 'pending' ORDER BY b.id`,
      ).all());
      return;
    }
    case "close": {
      const [id] = args;
      if (!id) throw new Error("Usage: close <handoff-id>");
      const r = open().prepare("UPDATE handoffs SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(new Date().toISOString(), Number(id));
      console.log(r.changes ? "Closed. The assistant will answer this customer again." : "No open handoff with that id.");
      return;
    }
    case "server": {
      const db = open();
      const deps: Deps = {
        db,
        profile,
        llm: freeModels(db),
        channel: values.dry ? new ConsoleChannel() : liveChannel(),
        now: () => new Date(),
        guardLlm: guardOn(),
      };
      const handler = createWebhookHandler(deps, {
        verifyToken: process.env["WHATSAPP_VERIFY_TOKEN"] ?? "",
        appSecret: process.env["WHATSAPP_APP_SECRET"] ?? "",
      });
      const port = Number(process.env["PORT"] ?? 3000);
      createServer((req, res) => void handler(req, res)).listen(port, () => {
        console.log(`Webhook listening on port ${port}${values.dry ? " (dry run, nothing is sent)" : ""}`);
      });
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
