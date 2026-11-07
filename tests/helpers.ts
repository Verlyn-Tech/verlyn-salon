import { readFileSync } from "node:fs";
import { SalonProfileSchema, type SalonProfile } from "../src/config.ts";
import type { AgentName, JsonRequest, JsonResult, LLM } from "../src/llm/types.ts";

export const profile: SalonProfile = SalonProfileSchema.parse(
  JSON.parse(readFileSync(new URL("../config/salon.example.json", import.meta.url), "utf8")),
);

export const NOW = new Date("2026-11-07T08:00:00Z"); // 12:00 in Dubai, inside the send window

export const CLIENT_HEADER = "client_id,first_name,phone,language,whatsapp_marketing_consent,consent_source\n";
export const VISIT_HEADER = "client_id,service,date,amount_aed,status\n";

/** Scripted stand-in for the model: returns set answers per agent and records what it was sent. */
export class ScriptedLLM implements LLM {
  calls: { agent: AgentName; system: string; user: string }[] = [];
  #answers: Partial<Record<AgentName, unknown | Error>>;

  constructor(answers: Partial<Record<AgentName, unknown | Error>>) {
    this.#answers = answers;
  }

  async completeJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    this.calls.push({ agent: req.agent, system: req.system, user: req.user });
    const answer = this.#answers[req.agent];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`Unexpected call to agent ${req.agent}`);
    return { data: req.schema.parse(answer), model: "scripted:free", attempts: 1 };
  }

  called(agent: AgentName): boolean {
    return this.calls.some((c) => c.agent === agent);
  }
}
