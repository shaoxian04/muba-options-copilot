import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeAnswer } from "./answer.js";
import { ForbiddenPhraseUsed } from "./guardrails.js";
import type { AgentCreateFn } from "./agent.js";
import type { Indicators, MarketData } from "@copilot/shared";

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

test("synthesizeAnswer includes comparison context for other coins when provided", async () => {
  let capturedUser = "";
  const otherMarketData: MarketData = {
    symbol: "SHIB",
    price: 0.00000505,
    priceSource: "coingecko",
    change24h: -2.9,
    high24h: 0.00000523,
    low24h: 0.00000491,
    volume24h: 77_000_000,
    statsSource: "coingecko",
    asOf: new Date().toISOString(),
  };
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "PEPE looks stronger than SHIB." }) }] };
  };
  await synthesizeAnswer(
    "which is stronger, PEPE or SHIB?",
    "PEPE",
    { market: marketData, otherCoins: [{ symbol: "SHIB", market: otherMarketData }] },
    fakeCreate
  );
  assert.match(capturedUser, /SHIB:/);
  assert.match(capturedUser, /comparison/i);
});

test("synthesizeAnswer includes recent conversation history in the prompt, delimited", async () => {
  let capturedUser = "";
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "PEPE is still around $0.00001." }) }] };
  };
  const history = [{ question: "what's ETH's price?", coins: [{ symbol: "ETH", answer: "ETH is at $2465, up 2%." }] }];
  await synthesizeAnswer("and PEPE?", "PEPE", { market: marketData, history }, fakeCreate);
  assert.match(capturedUser, /<<HISTORY>>/);
  assert.match(capturedUser, /ETH is at \$2465, up 2%\./);
});

test("synthesizeAnswer omits the history block entirely when history is empty or absent", async () => {
  let capturedUser = "";
  const fakeCreate: AgentCreateFn = async (params) => {
    capturedUser = params.messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ answer: "PEPE is at $0.00001." }) }] };
  };
  await synthesizeAnswer("what's PEPE's price?", "PEPE", { market: marketData }, fakeCreate);
  assert.ok(!capturedUser.includes("<<HISTORY>>"));
});

// --- indicators in the synthesis prompt --------------------------------------

const indicators: Indicators = {
  symbol: "ETH",
  close: 2451.25,
  rsi14: 28.42,
  sma20: 2600.5,
  ema20: 2550.75,
  candleSource: "binance",
  asOf: "2026-09-01T00:00:00+00:00",
};

function capture(answer = "ok"): { create: AgentCreateFn; seen: () => string } {
  let user = "";
  return {
    create: async (params) => {
      user = params.messages[0].content;
      return { content: [{ type: "text", text: JSON.stringify({ answer }) }] };
    },
    seen: () => user,
  };
}

test("synthesizeAnswer puts the indicator values in the prompt", async () => {
  const c = capture("ETH's RSI(14) is 28.4, below the usual oversold line.");
  await synthesizeAnswer("is ETH oversold?", "ETH", { indicators }, c.create);

  assert.match(c.seen(), /RSI\(14\) 28\.4/);
  assert.match(c.seen(), /SMA\(20\) \$2600\.50/);
  assert.match(c.seen(), /EMA\(20\) \$2550\.75/);
  assert.match(c.seen(), /Latest daily close \$2451\.25/);
});

test("synthesizeAnswer marks indicators COMPUTED so they are not hedged as a forecast", async () => {
  const c = capture();
  await synthesizeAnswer("is ETH oversold?", "ETH", { indicators }, c.create);
  assert.match(c.seen(), /COMPUTED/);
  assert.match(c.seen(), /not a forecast or an opinion/);
});

test("synthesizeAnswer omits an indicator still inside its warm-up window", async () => {
  const c = capture();
  await synthesizeAnswer("is ETH oversold?", "ETH", { indicators: { ...indicators, rsi14: null } }, c.create);

  assert.doesNotMatch(c.seen(), /RSI\(14\)/);
  assert.match(c.seen(), /SMA\(20\)/);
});

test("synthesizeAnswer says so plainly when no indicator has enough history", async () => {
  const c = capture();
  await synthesizeAnswer(
    "is it oversold?",
    "ETH",
    { indicators: { ...indicators, rsi14: null, sma20: null, ema20: null } },
    c.create
  );
  assert.match(c.seen(), /No indicator has enough history yet\./);
});

test("synthesizeAnswer carries indicators for the other coins in a comparison", async () => {
  const c = capture();
  await synthesizeAnswer(
    "which is more oversold, ETH or BTC?",
    "ETH",
    {
      indicators,
      otherCoins: [{ symbol: "BTC", indicators: { ...indicators, symbol: "BTC", rsi14: 71.9, close: 78169.37 } }],
    },
    c.create
  );

  assert.match(c.seen(), /RSI\(14\) 28\.4/);
  assert.match(c.seen(), /RSI\(14\) 71\.9/);
  assert.match(c.seen(), /For comparison/);
});
