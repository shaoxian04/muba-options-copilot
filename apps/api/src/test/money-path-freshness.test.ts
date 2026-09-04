/**
 * The trade path never reads a cached book. Treat this file as load-bearing.
 *
 * `upstream.ts` shares the book, market data and open interest between viewers, which is
 * what stops cost scaling with the number of open tabs. It must never extend to the path
 * that leads to a signature.
 *
 * ADR-0006 requires the Order to be re-fetched and every number re-derived at commit time;
 * `proposeChosenOrder` documents why in its own words -- an Order the maker has pulled
 * since the Deck was dealt must not be fillable from a stale snapshot, and a chosen Card
 * has to pass the same ADR-0002 gate an agent-chosen one does. A cache silently serving
 * `/propose` would undo both, and would do it invisibly: every test would still pass and
 * the Trader would simply be filled at a price they were shown seconds ago.
 *
 * This is the same shape of guard as the import-graph test that keeps a signer off
 * `/practice`. If it fails, do not relax it -- something has started reading the money
 * path through the cache.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { buyableOrders, buyableEverywhere } from "../thetanuts/orders.js";
import { spotPrice, spotPrices } from "../thetanuts/market.js";
import { __resetUpstreamCache } from "../thetanuts/upstream.js";
import { proposeTrade, proposeChosenOrder } from "../thetanuts/propose.js";
import { resetStub, spies } from "./stub-client.js";
import { NOW } from "./fixtures.js";

// The same frozen clock the other propose suites use. The stub book's expiries are
// relative to NOW, and a real clock walks straight past them.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  // resetStub() installs a live book with real expiries; overriding it with a static
  // fixture would only re-test the fixture's dates.
  resetStub();
  __resetUpstreamCache();
});

const intent = {
  underlying: "ETH" as const,
  direction: "DOWN" as const,
  horizonDays: 1,
  sizeUsdc: 2,
};

describe("read paths share one upstream call", () => {
  it("a second Deck read within the TTL does not refetch the book", async () => {
    await buyableOrders("ETH");
    await buyableOrders("ETH");
    // The whole point of the cache: one call, not two.
    expect(spies.fetchOrders).toHaveBeenCalledTimes(1);
  });

  it("different assets still share the one book read", async () => {
    // fetchOrders takes no arguments and returns every Underlying at once, so a SOL
    // viewer and an ETH viewer are asking the same question.
    await buyableOrders("ETH");
    await buyableOrders("SOL");
    expect(spies.fetchOrders).toHaveBeenCalledTimes(1);
  });

  it("the ticker rail shares it too", async () => {
    await buyableOrders("ETH");
    await buyableEverywhere();
    expect(spies.fetchOrders).toHaveBeenCalledTimes(1);
  });

  it("spot is read once and answers every symbol", async () => {
    await spotPrice("ETH");
    await spotPrice("BTC");
    await spotPrices();
    expect(spies.getMarketData).toHaveBeenCalledTimes(1);
  });
});

describe("the money path always refetches", () => {
  it("proposeTrade refetches the book even when a read path just cached it", async () => {
    await buyableOrders("ETH"); // a Deck poll, one moment earlier
    expect(spies.fetchOrders).toHaveBeenCalledTimes(1);

    await proposeTrade(intent);

    // ADR-0006: the Order is re-fetched and re-derived, never taken from the cache.
    expect(spies.fetchOrders).toHaveBeenCalledTimes(2);
  });

  it("proposeChosenOrder refetches, so a pulled Order cannot be filled from a snapshot", async () => {
    await buyableOrders("ETH");
    const chosen = (await buyableOrders("ETH")).find((o) => o.order.optionType === 1)!;
    const before = spies.fetchOrders.mock.calls.length;

    await proposeChosenOrder(intent, chosen);

    expect(spies.fetchOrders.mock.calls.length).toBeGreaterThan(before);
  });

  it("proposeTrade reads spot fresh rather than from the shared entry", async () => {
    await spotPrice("ETH"); // a Deck poll warmed it
    const before = spies.getMarketData.mock.calls.length;

    await proposeTrade(intent);

    // The Settlement Scenario ladder is drawn against this number.
    expect(spies.getMarketData.mock.calls.length).toBeGreaterThan(before);
  });

  it("two proposals in a row each refetch -- freshness is per call, not per window", async () => {
    await proposeTrade(intent);
    const after = spies.fetchOrders.mock.calls.length;
    await proposeTrade(intent);

    expect(spies.fetchOrders.mock.calls.length).toBeGreaterThan(after);
  });
});
