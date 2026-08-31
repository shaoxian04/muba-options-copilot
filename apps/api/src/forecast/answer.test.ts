import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeAnswer } from "./answer.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { AgentCreateFn } from "./agent.js";
import type { MarketData } from "@copilot/shared";

const marketData: MarketData = {
  symbol: "PEPE",
  price: 0.00001,
  priceSource: "coingecko",
  change24h: 2.1,
  high24h: 0.0000105,
  low24h: 0.0000095,
  volume24h: 500_000,
  statsSource: "coingecko",
  asOf: new Date().toISOString(),
};

test("synthesizeAnswer returns the model's answer for market-only context", async () => {
  let capturedUser = "";
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "PEPE is at $0.00001, up 2.1% over 24h." }) }] };
  };
  const answer = await synthesizeAnswer("what's PEPE's current price?", "PEPE", { market: marketData }, fakeCreate);
  assert.equal(answer, "PEPE is at $0.00001, up 2.1% over 24h.");
  assert.match(capturedUser, /Real current market data/);
  assert.match(capturedUser, /what's PEPE's current price\?/);
  assert.match(capturedUser, /Question:\n"""\n/);
});

test("synthesizeAnswer says plainly that nothing was gathered when context is empty", async () => {
  let capturedUser = "";
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "No data was gathered for this asset." }) }] };
  };
  await synthesizeAnswer("any news on PEPE?", "PEPE", {}, fakeCreate);
  assert.match(capturedUser, /No data was gathered for this asset\./);
});

test("synthesizeAnswer refuses a response using the forbidden phrase 'max loss'", async () => {
  const fakeCreate: AgentCreateFn = async () => ({
    content: [{ type: "text", text: JSON.stringify({ answer: "Your max loss here could be significant." }) }],
  });
  await assert.rejects(
    () => synthesizeAnswer("what's the risk?", "ETH", { market: marketData }, fakeCreate),
    ForbiddenPhraseUsed
  );
});
