import type { z } from "zod";

export type AgentName = "router" | "enquiry" | "booking" | "retention" | "guard" | "reporter";

export interface JsonRequest<T> {
  agent: AgentName;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface JsonResult<T> {
  data: T;
  model: string;
  attempts: number;
}

export interface LLM {
  completeJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
}

export type UnavailableReason =
  | "free_quota_exhausted"
  | "no_free_models"
  | "all_attempts_failed"
  | "auth_failed";

/** Agents never see this as a crash: the orchestrator turns it into a staff handoff. */
export class LLMUnavailableError extends Error {
  readonly reason: UnavailableReason;
  constructor(reason: UnavailableReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "LLMUnavailableError";
    this.reason = reason;
  }
}
