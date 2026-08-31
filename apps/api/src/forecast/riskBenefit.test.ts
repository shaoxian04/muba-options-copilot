import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario } from "@copilot/shared";
import { assessRiskBenefit } from "./riskBenefit.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { AgentCreateFn } from "./agent.js";

const scenario = (): MarketScenario => ({
  symbol: "ETH",
  horizon: "7d",
  marketData: {
    symbol: "ETH",
    price: 2450,
    priceSource: "thetanuts",
    change24h: -0.4,
    high24h: 2500,
    low24h: 2400,
    volume24h: 1_000_000,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  },
  headlines: [],
  generatedAt: new Date().toISOString(),
});

test("assessRiskBenefit builds a full RiskBenefitView", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          upside: "Could push toward the recent high if sentiment turns.",
          downside: "Could retest recent lows on any negative catalyst.",
        }),
      },
    ],
  });
  const result = await assessRiskBenefit(scenario(), fakeCreate);
  assert.match(result.upside, /recent high/);
  assert.match(result.downside, /recent lows/);
  assert.equal(result.groundedOn.price, 2450);
  assert.equal(result.groundedOn.priceSource, "thetanuts");
});

test("assessRiskBenefit refuses a response that uses the forbidden phrase 'max loss'", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          upside: "Could gain meaningfully.",
          downside: "Your max loss here could be significant.",
        }),
      },
    ],
  });
  await assert.rejects(() => assessRiskBenefit(scenario(), fakeCreate), ForbiddenPhraseUsed);
});
