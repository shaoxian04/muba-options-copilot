import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketScenario } from "@copilot/shared";
import { predictPrice } from "./price.js";
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

test("predictPrice builds a full PricePrediction and echoes the grounding market data", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          direction: "up",
          predictedRange: { low: 2300, high: 2650 },
          confidence: "medium",
          rationale: "Momentum and headlines both lean modestly positive.",
        }),
      },
    ],
  });
  const result = await predictPrice(scenario(), fakeCreate);
  assert.equal(result.direction, "up");
  assert.deepEqual(result.predictedRange, { low: 2300, high: 2650 });
  assert.equal(result.groundedOn.price, 2450);
  assert.equal(result.groundedOn.priceSource, "thetanuts");
});

test("predictPrice refuses a response whose rationale uses the forbidden phrase 'max loss'", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          direction: "down",
          predictedRange: { low: 2200, high: 2400 },
          confidence: "low",
          rationale: "Your max loss on a move like this could be substantial.",
        }),
      },
    ],
  });
  await assert.rejects(() => predictPrice(scenario(), fakeCreate), ForbiddenPhraseUsed);
});
