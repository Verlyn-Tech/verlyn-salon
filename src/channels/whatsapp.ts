import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { InboundMessage } from "../agents/orchestrator.ts";
import type { Channel } from "./types.ts";

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

const SendResponse = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) });

export class WhatsAppChannel implements Channel {
  #config: WhatsAppConfig;

  constructor(config: WhatsAppConfig) {
    if (!config.token || !config.phoneNumberId) {
      throw new Error("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required for live sending");
    }
    this.#config = config;
  }

  async #post(payload: object): Promise<string> {
    const { graphVersion, phoneNumberId, token, fetchImpl = globalThis.fetch } = this.#config;
    const res = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed with HTTP ${res.status}`);
    return SendResponse.parse(await res.json()).messages[0]!.id;
  }

  sendText(to: string, body: string): Promise<string> {
    return this.#post({ to: to.replace(/^\+/, ""), type: "text", text: { body } });
  }

  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<string> {
    return this.#post({
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name,
        language: { code: language },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    });
  }
}

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const Webhook = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.looseObject({
            messages: z
              .array(z.looseObject({ from: z.string(), id: z.string(), type: z.string(), text: z.object({ body: z.string() }).optional() }))
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

/** Delivery receipts and other events carry no messages and come back as an empty list. */
export function parseWebhook(body: unknown): InboundMessage[] {
  const parsed = Webhook.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.entry.flatMap((e) =>
    e.changes.flatMap((c) =>
      (c.value.messages ?? []).map((m) => ({
        from: `+${m.from.replace(/^\+/, "")}`,
        providerId: m.id,
        kind: m.type === "text" ? ("text" as const) : ("other" as const),
        text: m.text?.body ?? `[${m.type} message]`,
      })),
    ),
  );
}
