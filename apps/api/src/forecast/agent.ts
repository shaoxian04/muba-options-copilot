/**
 * Three configured AI provider connections, plus a helper that calls one of them and
 * validates the JSON response against a Zod schema. Tried in order -- OpenAI, then
 * Groq (an open-weight model, since this key has no Llama chat model available),
 * then Claude -- each one used when the tier before it has no key configured or its
 * call itself throws. Every caller gets an optional `create` override so it can be
 * exercised in tests with zero network calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ZodType } from "zod";
import { anthropicApiKey, openaiApiKey, groqApiKey } from "../env.js";

export const FORECAST_MODEL = "claude-sonnet-5";
export const OPENAI_MODEL = "gpt-5.1";
export const GROQ_MODEL = "openai/gpt-oss-120b";

let cachedClient: Anthropic | undefined;
function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: anthropicApiKey() });
  return cachedClient;
}

let cachedOpenAI: OpenAI | undefined;
function getOpenAI(apiKey: string): OpenAI {
  if (cachedOpenAI) return cachedOpenAI;
  cachedOpenAI = new OpenAI({ apiKey });
  return cachedOpenAI;
}

let cachedGroq: OpenAI | undefined;
function getGroq(apiKey: string): OpenAI {
  if (cachedGroq) return cachedGroq;
  cachedGroq = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  return cachedGroq;
}

export class ForecastGenerationFailed extends Error {}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
}

export type AgentCreateFn = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{
  content: Array<{ type: string; text?: string }>;
  provider?: string;
  usage?: UsageInfo;
}>;

async function realClaudeCreate(params: Parameters<AgentCreateFn>[0]): ReturnType<AgentCreateFn> {
  const res = await getAnthropic().messages.create(params as any);
  const usage = res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : undefined;
  return { content: res.content as any, provider: "claude", ...(usage ? { usage } : {}) };
}

/** The subset of the `openai` SDK client this module actually calls -- narrow enough
 *  that a fake client can be built by hand in tests, with no SDK mocking involved. */
export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create: (args: {
        model: string;
        max_completion_tokens: number;
        messages: Array<{ role: "system" | "user"; content: string }>;
      }) => Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

/**
 * Shared request/response shape for OpenAI and any OpenAI-compatible endpoint (Groq).
 * `max_completion_tokens` is the non-deprecated field name in the OpenAI SDK -- passing
 * `max_tokens` here was silently dropped, so a response's own default token budget could
 * cut it off mid-JSON with no `max_tokens: 4096` upstream cap ever applied.
 */
export async function callOpenAICompatible(
  client: OpenAICompatibleClient,
  model: string,
  provider: string,
  params: Parameters<AgentCreateFn>[0]
): ReturnType<AgentCreateFn> {
  const res = await client.chat.completions.create({
    model,
    max_completion_tokens: params.max_tokens,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.messages[0].content },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "";
  const usage =
    res.usage?.prompt_tokens !== undefined && res.usage?.completion_tokens !== undefined
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
      : undefined;
  return { content: [{ type: "text", text }], provider, ...(usage ? { usage } : {}) };
}

async function realOpenAICreate(params: Parameters<AgentCreateFn>[0]): ReturnType<AgentCreateFn> {
  const key = openaiApiKey();
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return callOpenAICompatible(getOpenAI(key), OPENAI_MODEL, "openai", params);
}

async function realGroqCreate(params: Parameters<AgentCreateFn>[0]): ReturnType<AgentCreateFn> {
  const key = groqApiKey();
  if (!key) throw new Error("GROQ_API_KEY is not set");
  return callOpenAICompatible(getGroq(key), GROQ_MODEL, "groq", params);
}

export interface AgentFallbackDeps {
  openaiApiKey: () => string | undefined;
  openaiCreate: AgentCreateFn;
  groqApiKey: () => string | undefined;
  groqCreate: AgentCreateFn;
  claudeCreate: AgentCreateFn;
  /** Called once per failed tier with a message naming the tier and its error --
   *  defaults to a console warning. Optional purely so existing test fixtures that
   *  predate this field don't have to supply it. */
  logFallback?: (message: string) => void;
}

function defaultLogFallback(message: string): void {
  console.warn(`[forecast-agent] ${message}`);
}

const defaultAgentFallbackDeps: AgentFallbackDeps = {
  openaiApiKey,
  openaiCreate: realOpenAICreate,
  groqApiKey,
  groqCreate: realGroqCreate,
  claudeCreate: realClaudeCreate,
  logFallback: defaultLogFallback,
};

/**
 * Tries OpenAI first when a key is configured, then Groq, then Claude -- each tier
 * used when the one before it has no key set, or its call itself throws. Claude is
 * always attempted last, unconditionally, even with no key of its own (matching this
 * module's original single-provider behavior: a missing Claude key still surfaces as
 * a normal, catchable error rather than silently succeeding).
 *
 * Every tier's failure is both logged (via `logFallback`) and kept -- if all three
 * fail, the thrown error names every tier and its own message, instead of only the
 * last one. A 429 on tier one used to come out the other end as an unrelated "no API
 * key" error from tier three; now the real cause survives to both the log and the
 * error a caller sees.
 */
export async function realCreateWithFallback(
  params: Parameters<AgentCreateFn>[0],
  deps: AgentFallbackDeps = defaultAgentFallbackDeps
): ReturnType<AgentCreateFn> {
  const attempts: string[] = [];

  if (deps.openaiApiKey()) {
    try {
      return await deps.openaiCreate(params);
    } catch (e: any) {
      const message = `openai: ${e?.message ?? e}`;
      attempts.push(message);
      deps.logFallback?.(`${message} -- falling back to Groq`);
    }
  }

  if (deps.groqApiKey()) {
    try {
      return await deps.groqCreate(params);
    } catch (e: any) {
      const message = `groq: ${e?.message ?? e}`;
      attempts.push(message);
      deps.logFallback?.(`${message} -- falling back to Claude`);
    }
  }

  try {
    return await deps.claudeCreate(params);
  } catch (e: any) {
    const message = `claude: ${e?.message ?? e}`;
    attempts.push(message);
    deps.logFallback?.(`${message} -- no more providers to try`);
    throw new Error(`All AI providers failed: ${attempts.join("; ")}`);
  }
}

export interface UsageLogEvent {
  provider: string;
  callSite: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The `user` prompt actually sent. Not `system` too -- that's a static string per
   *  callSite, constant across every row, and cheaply looked up in code if ever needed. */
  input: string;
  /** The raw text the model returned, before JSON parsing/schema validation. */
  output: string;
}

/**
 * Console visibility (unchanged) plus a fire-and-forget write to the
 * forecast_usage_log Supabase table (usageLog.ts) for aggregatable cost/usage
 * visibility beyond grepping logs. Un-awaited on purpose -- a slow or failed DB
 * write must never add latency to, or be able to fail, an actual forecast response.
 * The dynamic import keeps this module free of a hard Supabase dependency at load
 * time, matching how every other optional integration in this codebase degrades.
 */
function defaultLogUsage(event: UsageLogEvent): void {
  const tokens =
    event.inputTokens !== undefined ? ` inputTokens=${event.inputTokens} outputTokens=${event.outputTokens}` : "";
  console.log(`[forecast-agent] callSite=${event.callSite} provider=${event.provider} latencyMs=${event.latencyMs}${tokens}`);

  void import("./usageLog.js")
    .then(({ logUsageToSupabase }) => logUsageToSupabase(event))
    .catch((e) => console.warn(`[forecast-agent] usage-log import failed: ${e?.message ?? e}`));
}

/**
 * Calls the configured agent, expects a single JSON object back, validates it against
 * `schema`. The schema's Input type param is widened to `any` here so a schema with a
 * `.default()` field (whose Input and Output types differ) can still be assigned to
 * `ZodType<T>` -- otherwise TypeScript infers T from the narrower Input type instead of
 * the Output type, and every caller ends up with an incorrectly-optional field.
 *
 * Every call that reaches a provider is logged via `logUsage` (provider, latency,
 * token counts when the provider reports them) -- this is the only place any of that
 * is observable; nothing further downstream sees which tier answered a given request.
 * `callSite` names the calling function (e.g. "predictPrice") so usage/cost is
 * attributable per feature, not just per provider.
 */
export async function callAgentForJson<T>(
  schema: ZodType<T, any, any>,
  system: string,
  user: string,
  callSite: string,
  create: AgentCreateFn = realCreateWithFallback,
  logUsage: (event: UsageLogEvent) => void = defaultLogUsage
): Promise<T> {
  let raw: string;
  const startedAt = Date.now();
  try {
    const response = await create({
      model: FORECAST_MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });
    // Extracted before logUsage (not after) so a malformed/empty response still gets
    // logged -- that's a real, billed call worth seeing in the audit log, not silence.
    const block = response.content.find((b) => b.type === "text" && typeof b.text === "string");
    const text = block?.text;
    logUsage({
      provider: response.provider ?? "unknown",
      callSite,
      input: user,
      output: text ?? "",
      latencyMs: Date.now() - startedAt,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });
    if (!text) throw new Error("No text content in agent response");
    raw = text;
  } catch (e: any) {
    throw new ForecastGenerationFailed(`Agent call failed: ${e?.message ?? e}`);
  }

  let parsed: unknown;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    throw new ForecastGenerationFailed(`Agent did not return valid JSON: ${raw.slice(0, 200)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new ForecastGenerationFailed(`Agent output failed schema validation: ${result.error.message}`);
  return result.data;
}
