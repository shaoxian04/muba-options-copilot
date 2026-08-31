/**
 * Two configured AI provider connections, plus a helper that calls one of them and
 * validates the JSON response against a Zod schema. OpenAI is tried first when
 * OPENAI_API_KEY is configured; Claude is the fallback -- used when no OpenAI key is
 * set, or when the OpenAI call itself throws. Every caller gets an optional `create`
 * override so it can be exercised in tests with zero network calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ZodType } from "zod";
import { anthropicApiKey, openaiApiKey } from "../env.js";

export const FORECAST_MODEL = "claude-sonnet-5";
export const OPENAI_MODEL = "gpt-5.1";

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

export class ForecastGenerationFailed extends Error {}

export type AgentCreateFn = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ content: Array<{ type: string; text?: string }> }>;

async function realClaudeCreate(params: Parameters<AgentCreateFn>[0]): ReturnType<AgentCreateFn> {
  const res = await getAnthropic().messages.create(params as any);
  return res as any;
}

async function realOpenAICreate(params: Parameters<AgentCreateFn>[0]): ReturnType<AgentCreateFn> {
  const key = openaiApiKey();
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const res = await getOpenAI(key).chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.messages[0].content },
    ],
  });
  const text = res.choices[0]?.message?.content ?? "";
  return { content: [{ type: "text", text }] };
}

export interface AgentFallbackDeps {
  openaiApiKey: () => string | undefined;
  openaiCreate: AgentCreateFn;
  claudeCreate: AgentCreateFn;
}

const defaultAgentFallbackDeps: AgentFallbackDeps = {
  openaiApiKey,
  openaiCreate: realOpenAICreate,
  claudeCreate: realClaudeCreate,
};

/**
 * Tries OpenAI first when a key is configured; falls back to Claude when no OpenAI
 * key is set, or when the OpenAI call itself throws.
 */
export async function realCreateWithFallback(
  params: Parameters<AgentCreateFn>[0],
  deps: AgentFallbackDeps = defaultAgentFallbackDeps
): ReturnType<AgentCreateFn> {
  if (deps.openaiApiKey()) {
    try {
      return await deps.openaiCreate(params);
    } catch {
      // fall through to Claude
    }
  }
  return deps.claudeCreate(params);
}

/** Calls the configured agent, expects a single JSON object back, validates it against `schema`. */
export async function callAgentForJson<T>(
  schema: ZodType<T>,
  system: string,
  user: string,
  create: AgentCreateFn = realCreateWithFallback
): Promise<T> {
  let raw: string;
  try {
    const response = await create({
      model: FORECAST_MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = response.content.find((b) => b.type === "text" && typeof b.text === "string");
    if (!block?.text) throw new Error("No text content in Claude response");
    raw = block.text;
  } catch (e: any) {
    throw new ForecastGenerationFailed(`Claude call failed: ${e?.message ?? e}`);
  }

  let parsed: unknown;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    throw new ForecastGenerationFailed(`Claude did not return valid JSON: ${raw.slice(0, 200)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new ForecastGenerationFailed(`Claude output failed schema validation: ${result.error.message}`);
  return result.data;
}
