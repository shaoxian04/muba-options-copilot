import { RiskBenefitView, FORECAST_DISCLAIMER, type MarketScenario } from "@copilot/shared";
import { callAgentForJson, type AgentCreateFn } from "./agent.js";
import { assertNoForbiddenPhrase } from "./guardrails.js";

const RiskBenefitModel = RiskBenefitView.omit({
  symbol: true,
  horizon: true,
  groundedOn: true,
  disclaimer: true,
  generatedAt: true,
});

export async function assessRiskBenefit(scenario: MarketScenario, create?: AgentCreateFn): Promise<RiskBenefitView> {
  const { marketData } = scenario;
  const model = await callAgentForJson(
    RiskBenefitModel,
    'You write a qualitative risk/benefit view of a crypto asset given real market data and ' +
      'simulated news. This is illustrative opinion, never a guarantee. ' +
      'You must NEVER use the phrase "max loss" or present any number as a guaranteed outcome -- ' +
      'frame everything as "could", "might", "a scenario like X". ' +
      'Output ONLY JSON: {"upside": string (2-3 sentences), "downside": string (2-3 sentences)}.',
    `Symbol: ${scenario.symbol}\nHorizon: ${scenario.horizon}\n` +
      `Current price: $${marketData.price}\n24h change: ${marketData.change24h}%\n` +
      `24h high: $${marketData.high24h}\n24h low: $${marketData.low24h}\n` +
      `Headlines:\n${scenario.headlines.map((h) => `- ${h.text}`).join("\n")}`,
    create
  );

  assertNoForbiddenPhrase(model.upside);
  assertNoForbiddenPhrase(model.downside);

  return {
    symbol: scenario.symbol,
    horizon: scenario.horizon,
    upside: model.upside,
    downside: model.downside,
    groundedOn: marketData,
    disclaimer: FORECAST_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}
