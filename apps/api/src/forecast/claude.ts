/**
 * One configured Anthropic connection, plus a helper that calls Claude and validates
 * its JSON response against a Zod schema. Every caller in this module gets an
 * optional `create` override so it can be exercised in tests with zero network calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import { anthropicApiKey } from "../env.js";

export const FORECAST_MODEL = "claude-sonnet-5";

let cachedClient: Anthropic | undefined;
function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: anthropicApiKey() });
  return cachedClient;
}

export class ForecastGenerationFailed extends Error {}

export type ClaudeCreateFn = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<{ content: Array<{ type: string; text?: string }> }>;

async function realClaudeCreate(params: Parameters<ClaudeCreateFn>[0]): ReturnType<ClaudeCreateFn> {
  const res = await getAnthropic().messages.create(params as any);
  return res as any;
}

/** Calls Claude, expects a single JSON object back, validates it against `schema`. */
export async function callClaudeForJson<T>(
  schema: ZodType<T>,
  system: string,
  user: string,
  create: ClaudeCreateFn = realClaudeCreate
): Promise<T> {
  let raw: string;
  try {
    const response = await create({
      model: FORECAST_MODEL,
      max_tokens: 1024,
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
