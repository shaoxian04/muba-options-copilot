import { z } from "zod";
import { TradeIntent, UnderlyingSymbol } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "../forecast/agent.js";

export const ExtractedTradeIntent = z.object({
  underlying: UnderlyingSymbol.default("ETH"),
  direction: z.enum(["UP", "DOWN"]).default("DOWN"),
  sizeUsdc: z.number().positive().max(1000).default(2),
  horizonDays: z.number().int().min(1).max(30).default(1),
  explanation: z.string().default("I've matched an option based on your request."),
});
export type ExtractedTradeIntent = z.infer<typeof ExtractedTradeIntent>;

/**
 * Deterministic regex fallback parser for common natural language patterns
 * when no LLM API key is configured or when the LLM service is offline.
 */
export function fallbackExtractIntent(text: string): ExtractedTradeIntent {
  const upper = text.toUpperCase();

  // 1. Underlying extraction
  let underlying: "ETH" | "BTC" | "SOL" = "ETH";
  if (/\b(BTC|BITCOIN)\b/i.test(upper) || /(比特币|大饼)/i.test(upper)) {
    underlying = "BTC";
  } else if (/\b(SOL|SOLANA)\b/i.test(upper) || /(索拉纳)/i.test(upper)) {
    underlying = "SOL";
  } else if (/\b(ETH|ETHEREUM)\b/i.test(upper) || /(以太坊|以太)/i.test(upper)) {
    underlying = "ETH";
  }

  // 2. Direction extraction
  let direction: "UP" | "DOWN" = "DOWN";
  if (
    /\b(UP|BULL|BULLISH|CALL|RISE|PUMP|LONG)\b/i.test(upper) ||
    /(做多|看涨|买涨)/i.test(upper)
  ) {
    direction = "UP";
  } else if (
    /\b(DOWN|BEAR|BEARISH|PUT|DROP|DUMP|SHORT|PROTECT|HEDGE|COVER)\b/i.test(upper) ||
    /(保险|做空|看跌|防跌|对冲|保护)/i.test(upper)
  ) {
    direction = "DOWN";
  }

  // 3. Size USDC extraction (e.g. "$50", "50 USDC", "50刀", "50块", "50 USD", "with 20")
  let sizeUsdc = 2;
  const sizeMatch =
    text.match(/\$\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|USD|DOLLARS?|刀|块|元)/i) ||
    text.match(/(?:WITH|FOR|花|用|投|投入)\s*(\d+(?:\.\d+)?)/i);
  if (sizeMatch && sizeMatch[1]) {
    const parsedSize = parseFloat(sizeMatch[1]);
    if (!isNaN(parsedSize) && parsedSize > 0 && parsedSize <= 1000) {
      sizeUsdc = parsedSize;
    }
  }

  // 4. Horizon extraction (e.g. "2 days", "3d", "1 week", "2天", "1周")
  let horizonDays = 1;
  const daysMatch =
    text.match(/(\d+)\s*(?:DAYS?|D|天)/i) ||
    text.match(/(?:FOR|NEXT|OVER|看|未来)\s*(\d+)\s*(?:DAYS?|D|天)/i);
  const weekMatch = text.match(/(\d+)\s*(?:WEEKS?|W|周|星期)/i);

  if (daysMatch && daysMatch[1]) {
    const parsedDays = parseInt(daysMatch[1], 10);
    if (!isNaN(parsedDays) && parsedDays >= 1 && parsedDays <= 30) {
      horizonDays = parsedDays;
    }
  } else if (weekMatch && weekMatch[1]) {
    const parsedWeeks = parseInt(weekMatch[1], 10);
    if (!isNaN(parsedWeeks) && parsedWeeks >= 1) {
      horizonDays = Math.min(30, parsedWeeks * 7);
    }
  } else if (/\b(TOMORROW|明天)\b/i.test(upper)) {
    horizonDays = 1;
  } else if (/\b(WEEK|一周|这周)\b/i.test(upper)) {
    horizonDays = 7;
  }

  const dirWord = direction === "UP" ? "upside (Call)" : "protection (Put)";
  const explanation = `Matched ${underlying} ${dirWord} for ${horizonDays} day(s) with $${sizeUsdc} stake.`;

  return {
    underlying,
    direction,
    sizeUsdc,
    horizonDays,
    explanation,
  };
}

const SYSTEM_PROMPT = `You are the Trade Agent for Options Copilot on Thetanuts Finance V4.
Your job is to read the trader's natural language input (in English, Chinese, or any language) and extract a valid TradeIntent.

Options available:
- underlying: "ETH" | "BTC" | "SOL" (default: "ETH" if not specified)
- direction: "UP" (for calls, bullish, long, price rises) or "DOWN" (for puts, protection, hedge, drops, dumps)
- sizeUsdc: dollar amount number in USDC (default: 2 if not mentioned, maximum 1000)
- horizonDays: integer number of days between 1 and 7 (default: 1 if not mentioned)
- explanation: a concise, friendly 1-sentence plain-English response summarizing the trade you found.

Output ONLY valid JSON matching this schema:
{
  "underlying": "ETH" | "BTC" | "SOL",
  "direction": "UP" | "DOWN",
  "sizeUsdc": number,
  "horizonDays": number,
  "explanation": string
}`;

/**
 * Extracts a TradeIntent and user-friendly explanation from a natural language prompt.
 */
export async function extractTradeIntent(
  userPrompt: string,
  create?: AgentCreateFn
): Promise<{ intent: TradeIntent; explanation: string }> {
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    const fallback = fallbackExtractIntent("Protect ETH for 1 day with 2 USDC");
    return {
      intent: {
        underlying: fallback.underlying,
        direction: fallback.direction,
        sizeUsdc: fallback.sizeUsdc,
        horizonDays: fallback.horizonDays,
      },
      explanation: "Please describe what you'd like to do (e.g., 'Protect my ETH for 2 days with 20 USDC').",
    };
  }

  try {
    const extracted = await callAgentForJson(
      ExtractedTradeIntent,
      SYSTEM_PROMPT,
      `Trader message: "${trimmed}"`,
      "extractTradeIntent",
      create
    );

    const intent = TradeIntent.parse({
      underlying: extracted.underlying,
      direction: extracted.direction,
      sizeUsdc: extracted.sizeUsdc,
      horizonDays: extracted.horizonDays,
    });

    return { intent, explanation: extracted.explanation };
  } catch (err) {
    // If AI fails or no key configured, seamlessly use deterministic fallback parser
    const fallback = fallbackExtractIntent(trimmed);
    const intent = TradeIntent.parse({
      underlying: fallback.underlying,
      direction: fallback.direction,
      sizeUsdc: fallback.sizeUsdc,
      horizonDays: fallback.horizonDays,
    });
    return { intent, explanation: fallback.explanation };
  }
}
