import { z } from "zod";
import { LLMUnavailableError, type JsonRequest, type JsonResult, type LLM } from "./types.ts";

const CatalogSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      context_length: z.number().nullish(),
      pricing: z.looseObject({ prompt: z.string(), completion: z.string() }).nullish(),
      architecture: z.looseObject({ output_modalities: z.array(z.string()).nullish() }).nullish(),
      supported_parameters: z.array(z.string()).nullish(),
    }),
  ),
});

type RawModel = z.infer<typeof CatalogSchema>["data"][number];

export interface FreeModel {
  id: string;
  contextLength: number;
  jsonMode: boolean;
}

/** Both checks must pass: a ":free" id AND a listed price of exactly zero. */
export function isFreeModel(m: RawModel): boolean {
  if (!m.id.endsWith(":free") || !m.pricing) return false;
  if (Number(m.pricing.prompt) !== 0 || Number(m.pricing.completion) !== 0) return false;
  const out = m.architecture?.output_modalities;
  if (out && !out.includes("text")) return false;
  return (m.context_length ?? 0) >= 8000;
}

export function selectFreeModels(raw: RawModel[]): FreeModel[] {
  return raw
    .filter(isFreeModel)
    .map((m) => ({
      id: m.id,
      contextLength: m.context_length ?? 0,
      jsonMode: Boolean(m.supported_parameters?.includes("response_format")),
    }))
    .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id));
}

/** What differs between providers. Cycling, benching and validation are shared. */
export interface ProviderSpec {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
  fetchCatalog(fetchImpl: typeof fetch, apiKey: string): Promise<FreeModel[]>;
  /** Checked again immediately before every request. */
  isAllowed(modelId: string): boolean;
  /** When the whole account is out of quota, returns when to resume. Otherwise null. */
  accountCapUntil(res: Response, body: string, now: number): number | null;
  label(modelId: string): string;
}

export const openRouterProvider: ProviderSpec = {
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  headers: { "X-Title": "Verlyn Rebook" },
  async fetchCatalog(fetchImpl) {
    const res = await fetchImpl("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    return selectFreeModels(CatalogSchema.parse(await res.json()).data);
  },
  isAllowed: (id) => id.endsWith(":free"),
  accountCapUntil(res, body, now) {
    if (res.headers.get("x-ratelimit-remaining") !== "0" && !/free-models-per-(day|min)/i.test(body)) return null;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return Number.isFinite(reset) && reset > now ? reset : now + MIN;
  },
  label: (id) => id,
};

/**
 * Chat models this system may use. Only those a key can actually access get used.
 * Qwen and MiniMax are Groq preview models, which can vanish at short notice.
 * The safeguard model has a low per-minute limit, so it's backup only.
 */
export const GROQ_DEFAULT_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
  "qwen/qwen3.8-27b",
  "minimaxai/minimax-m2.7",
  "openai/gpt-oss-safeguard-20b",
];

/**
 * Groq has no per-model free flag: whether a request is free depends on the
 * account's plan, which this code can't see. The allowlist limits which models
 * are used, but only keeping the account on the free plan guarantees no charges.
 */
export function groqProvider(allowed: string[] = GROQ_DEFAULT_MODELS): ProviderSpec {
  return {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    headers: {},
    async fetchCatalog(fetchImpl, apiKey) {
      const res = await fetchImpl("https://api.groq.com/openai/v1/models", {
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const body = z.object({ data: z.array(z.looseObject({ id: z.string(), active: z.boolean().nullish(), context_window: z.number().nullish() })) }).parse(await res.json());
      const live = new Map(body.data.filter((m) => m.active !== false).map((m) => [m.id, m]));
      return allowed
        .filter((id) => live.has(id))
        .map((id) => ({ id, contextLength: live.get(id)?.context_window ?? 0, jsonMode: true }));
    },
    isAllowed: (id) => allowed.includes(id),
    // Groq's limits are per model, so a 429 only benches that model.
    accountCapUntil: () => null,
    label: (id) => `groq:${id}`,
  };
}

/** Tolerates code fences and reasoning tags, which free models often emit around JSON. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export interface AttemptEvent {
  agent: string;
  model: string;
  outcome: string;
}

export interface FreeModelRouterOptions {
  apiKey: string;
  provider?: ProviderSpec;
  preferredPrefixes?: string[];
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  catalogTtlMs?: number;
  /** If a model frees up within this time, wait for it instead of giving up. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  onAttempt?: (e: AttemptEvent) => void;
}

const MIN = 60_000;

/**
 * Cycles through a provider's permitted models and never calls anything else.
 * Each request starts at the next model in the rotation. A failing model is
 * benched for a while and the request moves on. A hit on an account-wide cap
 * stops immediately, since another model would fail the same way.
 */
export class FreeModelRouter implements LLM {
  #o: Required<Omit<FreeModelRouterOptions, "onAttempt">> & Pick<FreeModelRouterOptions, "onAttempt">;
  #catalog: FreeModel[] = [];
  #catalogAt = -Infinity;
  #cursor = 0;
  #bench = new Map<string, number>();
  #pausedUntil = 0;

  constructor(options: FreeModelRouterOptions) {
    if (!options.apiKey) throw new LLMUnavailableError("auth_failed", "OPENROUTER_API_KEY is not set");
    this.#o = {
      provider: openRouterProvider,
      preferredPrefixes: [],
      maxAttempts: 4,
      attemptTimeoutMs: 45_000,
      catalogTtlMs: 10 * MIN,
      maxWaitMs: 25_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetchImpl: globalThis.fetch,
      clock: Date.now,
      ...options,
    };
  }

  async listFreeModels(force = false): Promise<FreeModel[]> {
    const now = this.#o.clock();
    if (!force && now - this.#catalogAt < this.#o.catalogTtlMs && this.#catalog.length) return this.#catalog;
    try {
      this.#catalog = await this.#o.provider.fetchCatalog(this.#o.fetchImpl, this.#o.apiKey);
      this.#catalogAt = now;
    } catch (err) {
      // A stale list beats no list; a model that has gone away just gets benched.
      if (!this.#catalog.length) throw new LLMUnavailableError("no_free_models", String(err));
    }
    return this.#catalog;
  }

  /** Rotation order for the next request: preferred models first, then the rest. */
  #nextOrder(models: FreeModel[]): FreeModel[] {
    const now = this.#o.clock();
    const ready = models.filter((m) => (this.#bench.get(m.id) ?? 0) <= now);
    const { preferredPrefixes: prefixes } = this.#o;
    const isPreferred = (m: FreeModel) => prefixes.some((p) => m.id.startsWith(p));
    const rotate = (list: FreeModel[]) => {
      if (!list.length) return list;
      const k = this.#cursor % list.length;
      return [...list.slice(k), ...list.slice(0, k)];
    };
    const order = [...rotate(ready.filter(isPreferred)), ...rotate(ready.filter((m) => !isPreferred(m)))];
    this.#cursor++;
    return order;
  }

  async completeJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    if (this.#o.clock() < this.#pausedUntil) {
      throw new LLMUnavailableError("free_quota_exhausted", "paused until the free limit resets");
    }
    const models = await this.listFreeModels();
    const system = `${req.system}\n\nReturn only one JSON object, with no other text, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}`;
    let attempts = 0;
    for (let round = 0; round < 2; round++) {
      for (const model of this.#nextOrder(models).slice(0, this.#o.maxAttempts)) {
        attempts++;
        const outcome = await this.#attempt(model, system, req);
        const label = this.#o.provider.label(model.id);
        this.#o.onAttempt?.({ agent: req.agent, model: label, outcome: outcome.ok ? "ok" : outcome.error });
        if (outcome.ok) return { data: outcome.data, model: label, attempts };
      }
      // Per-minute limits clear in seconds. A short wait beats moving to another
      // provider, or sending the customer to staff.
      const wait = this.#msUntilNextModel(models);
      // Zero means a model is ready and the attempt cap stopped us, so don't go again.
      if (round > 0 || wait === null || wait === 0 || wait > this.#o.maxWaitMs) break;
      await this.#o.sleep(wait);
    }
    if (!attempts) throw new LLMUnavailableError("no_free_models", "every permitted model is benched");
    throw new LLMUnavailableError("all_attempts_failed", `${attempts} attempts failed`);
  }

  #msUntilNextModel(models: FreeModel[]): number | null {
    if (!models.length) return null;
    const now = this.#o.clock();
    return Math.max(0, Math.min(...models.map((m) => (this.#bench.get(m.id) ?? 0) - now)));
  }

  async #attempt<T>(
    model: FreeModel,
    system: string,
    req: JsonRequest<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const { provider } = this.#o;
    // Last line of defence: a model outside the provider's rules never gets called.
    if (!provider.isAllowed(model.id)) throw new Error(`Refusing model ${model.id} on ${provider.name}`);
    const now = this.#o.clock();
    let res: Response;
    try {
      res = await this.#o.fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(this.#o.attemptTimeoutMs),
        headers: {
          Authorization: `Bearer ${this.#o.apiKey}`,
          "Content-Type": "application/json",
          ...provider.headers,
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: req.maxTokens ?? 1500,
          messages: [
            { role: "system", content: system },
            { role: "user", content: req.user },
          ],
          ...(model.jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch {
      this.#bench.set(model.id, now + 2 * MIN);
      return { ok: false, error: "network_or_timeout" };
    }

    const bodyText = await res.text();
    if (res.status === 401) throw new LLMUnavailableError("auth_failed", `${provider.name} rejected the API key`);

    if (res.status === 429) {
      const capUntil = provider.accountCapUntil(res, bodyText, now);
      if (capUntil !== null) {
        this.#pausedUntil = capUntil;
        throw new LLMUnavailableError("free_quota_exhausted", `HTTP 429 on ${model.id}`);
      }
      const retry = Number(res.headers.get("retry-after"));
      this.#bench.set(model.id, now + (retry > 0 ? retry * 1000 : MIN));
      return { ok: false, error: "model_rate_limited" };
    }
    if (res.status === 404 || res.status === 402) {
      this.#bench.set(model.id, now + 60 * MIN);
      this.#catalogAt = -Infinity;
      return { ok: false, error: `model_gone_${res.status}` };
    }
    if (!res.ok) {
      // A 400 is usually one bad generation, such as failed JSON mode, not an outage.
      this.#bench.set(model.id, now + (res.status === 400 ? 30_000 : 2 * MIN));
      return { ok: false, error: `http_${res.status}` };
    }

    try {
      const json = JSON.parse(bodyText) as {
        error?: { message?: string };
        choices?: { message?: { content?: string | null } }[];
      };
      if (json.error) throw new Error(json.error.message ?? "error in 200 response");
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty content");
      const parsed = req.schema.safeParse(extractJson(content));
      if (!parsed.success) throw new Error("schema mismatch");
      return { ok: true, data: parsed.data };
    } catch (err) {
      // One bad answer is often a one-off, so this is a short bench.
      this.#bench.set(model.id, now + 30_000);
      return { ok: false, error: `bad_output: ${err instanceof Error ? err.message : "unknown"}` };
    }
  }
}
