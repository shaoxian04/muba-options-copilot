import { PricePrediction, FORECAST_DISCLAIMER, type MarketScenario } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { assertNoForbiddenPhrase } from "./guardrails.js";

const PricePredictionModel = PricePrediction.omit({
  symbol: true,
  horizon: true,
  groundedOn: true,
  disclaimer: true,
  generatedAt: true,
});

export async function predictPrice(scenario: MarketScenario, create?: AgentCreateFn): Promise<PricePrediction> {
  const { marketData } = scenario;
  const model = await callAgentForJson(
    PricePredictionModel,
    'You produce a speculative price prediction for a crypto asset given real current market data ' +
      'and simulated news headlines. This is opinion, not certainty. ' +
      'Output ONLY JSON: {"direction": "up"|"down"|"flat", "predictedRange": {"low": number, "high": number}, ' +
      '"confidence": "low"|"medium"|"high", "rationale": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHorizon: ${scenario.horizon}\n` +
      `Current price: $${marketData.price} (source: ${marketData.priceSource})\n` +
      `24h change: ${marketData.change24h}%\n24h high: $${marketData.high24h}\n24h low: $${marketData.low24h}\n` +
      `24h volume: $${marketData.volume24h}\n` +
      `Headlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    create
  );
  assertNoForbiddenPhrase(model.rationale);
  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    direction: model.direction,
    predictedRange: model.predictedRange,
    confidence: model.confidence,
    rationale: model.rationale,
    groundedOn: marketData,
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
