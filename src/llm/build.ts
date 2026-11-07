import { FreeModelRouter, GROQ_DEFAULT_MODELS, groqProvider, type AttemptEvent } from "./freeModels.ts";
import { LLMUnavailableError, type JsonRequest, type JsonResult, type LLM } from "./types.ts";

export interface ProviderFailure {
  provider: string;
  reason: string;
}

/** Tries each provider in order. A provider that is out or down passes to the next. */
export class ProviderChain implements LLM {
  #providers: { name: string; llm: LLM }[];
  #onFailover: ((f: ProviderFailure) => void) | undefined;

  constructor(providers: { name: string; llm: LLM }[], onFailover?: (f: ProviderFailure) => void) {
    this.#providers = providers;
    this.#onFailover = onFailover;
  }

  get names(): string[] {
    return this.#providers.map((p) => p.name);
  }

  async completeJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    let last: LLMUnavailableError | undefined;
    for (const { name, llm } of this.#providers) {
      try {
        return await llm.completeJson(req);
      } catch (err) {
        if (!(err instanceof LLMUnavailableError)) throw err;
        last = err;
        this.#onFailover?.({ provider: name, reason: err.reason });
      }
    }
    throw last ?? new LLMUnavailableError("no_free_models", "no provider configured");
  }
}

const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export interface BuildOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  onAttempt?: (e: AttemptEvent) => void;
  onFailover?: (f: ProviderFailure) => void;
}

/**
 * Builds the model chain from the environment. LLM_PROVIDERS sets the order and
 * is also a hard limit, so "groq" alone means nothing is ever sent to OpenRouter.
 */
export function buildLlm(options: BuildOptions = {}): ProviderChain {
  const { env = process.env, fetchImpl, onAttempt, onFailover } = options;
  const maxAttempts = Number(env["MAX_MODEL_ATTEMPTS"] || 4);
  const shared = { maxAttempts, ...(fetchImpl ? { fetchImpl } : {}), ...(onAttempt ? { onAttempt } : {}) };
  const order = list(env["LLM_PROVIDERS"]);
  const unknown = order.filter((p) => p !== "groq" && p !== "openrouter");
  if (unknown.length) throw new Error(`Unknown LLM_PROVIDERS value: ${unknown.join(", ")}. Use groq, openrouter or both.`);

  const keyFor: Record<string, string | undefined> = { groq: env["GROQ_API_KEY"], openrouter: env["OPENROUTER_API_KEY"] };
  const enabled = (order.length ? order : ["groq", "openrouter"]).filter((name) => keyFor[name]);
  const providers: { name: string; llm: LLM }[] = [];
  for (const name of enabled) {
    // With another provider behind it, a limited provider hands over straight away.
    // Only the last one waits out a short limit, since nothing else can answer.
    const wait = name === enabled.at(-1) ? {} : { maxWaitMs: 0 };
    if (name === "groq" && env["GROQ_API_KEY"]) {
      const models = list(env["GROQ_MODELS"]);
      providers.push({
        name,
        llm: new FreeModelRouter({
          ...shared,
          ...wait,
          apiKey: env["GROQ_API_KEY"],
          provider: groqProvider(models.length ? models : GROQ_DEFAULT_MODELS),
          // These share normal traffic, which also spreads the per-model minute limit.
          preferredPrefixes: list(env["GROQ_PREFERRED_MODELS"] ?? "meta-llama/llama-4,llama-3.3,openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/,minimaxai/"),
        }),
      });
    }
    if (name === "openrouter" && env["OPENROUTER_API_KEY"]) {
      providers.push({
        name,
        llm: new FreeModelRouter({
          ...shared,
          ...wait,
          apiKey: env["OPENROUTER_API_KEY"],
          preferredPrefixes: list(env["PREFERRED_MODEL_PREFIXES"] ?? "nvidia/"),
        }),
      });
    }
  }
  if (!providers.length) {
    throw new Error(
      order.length
        ? `No API key set for LLM_PROVIDERS=${order.join(",")}. Add it to .env.`
        : "No API key found. Add GROQ_API_KEY or OPENROUTER_API_KEY to .env.",
    );
  }
  return new ProviderChain(providers, onFailover);
}
