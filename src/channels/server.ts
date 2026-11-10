import type { IncomingMessage, ServerResponse } from "node:http";
import { handleInbound, type Deps } from "../agents/orchestrator.ts";
import { audit } from "../db.ts";
import { parseWebhook, verifySignature } from "./whatsapp.ts";

const MAX_BODY = 1_000_000;

export interface WebhookOptions {
  verifyToken: string;
  appSecret: string;
  phoneNumberId?: string;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createWebhookHandler(deps: Deps, options: WebhookOptions) {
  if (!options.verifyToken || !options.appSecret) {
    throw new Error("WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET are required");
  }
  // One at a time, so two quick messages from a customer can't race each other.
  let queue: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (url.pathname !== "/webhook") {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === options.verifyToken;
      res.writeHead(ok ? 200 : 403).end(ok ? (url.searchParams.get("hub.challenge") ?? "") : "");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    if (!raw) {
      res.writeHead(413).end();
      return;
    }
    const signature = req.headers["x-hub-signature-256"];
    if (!verifySignature(raw, Array.isArray(signature) ? signature[0] : signature, options.appSecret)) {
      res.writeHead(401).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Acknowledge straight away. Model calls can be slow, and Meta retries slow webhooks.
    res.writeHead(200).end();
    for (const message of parseWebhook(body, options.phoneNumberId)) {
      void runExclusive(async () => {
        try { await handleInbound(deps, message); }
        catch (err) { audit(deps.db, deps.now(), null, "server", "turn_failed", { error: String(err) }); }
      });
    }
  };
  return Object.assign(handler, { idle: () => queue, runExclusive });
}
