/**
 * The book's single door, now that it opens onto six Underlyings.
 *
 * These run at the filter seam -- `buyableOrders` -- because that is the one place
 * ADR-0002 and the registry allowlist are both enforced. Anything that reaches an Order
 * without passing through here has bypassed both, so testing the door tests the rule
 * rather than one caller's use of it.
 *
 * Stub Orders only. No network, no chain, no wallet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../thetanuts/client.js", () => import("./stub-client.js"));

const { state, resetStub } = await import("./stub-client.js");
const { buyableOrders, feedOf, underlyingOf } = await import("../thetanuts/orders.js");
const { spotPrice } = await import("../thetanuts/market.js");
const {
  UNDERLYINGS, SYMBOLS, underlyingForFeed, requireUnderlying, UnknownUnderlying, payoutAsset, ZERO_ADDRESS,
} = await import("../thetanuts/underlyings.js");
const { makeOrder, FEED } = await import("./fixtures.js");

beforeEach(resetStub);

describe("the registry", () => {
  it("covers the six Underlyings the live book quotes", () => {
    expect(SYMBOLS).toEqual(["BTC", "ETH", "SOL", "BNB", "XRP", "AVAX"]);
  });

  it("gives every Underlying a symbol, a display name, a feed and strike decimals", () => {
    for (const u of UNDERLYINGS) {
      expect(u.symbol).toMatch(/^[A-Z]+$/);
      expect(u.name.length).toBeGreaterThan(0);
      // Lowercased at rest, so no comparison anywhere has to remember to.
      expect(u.feed).toMatch(/^0x[0-9a-f]{40}$/);
      expect(u.priceDp).toBeGreaterThanOrEqual(0);
    }
  });

  it("keys on the feed, not the token -- four Underlyings share the zero token", () => {
    const cashSettled = UNDERLYINGS.filter((u) => u.token === ZERO_ADDRESS);
    expect(cashSettled.map((u) => u.symbol)).toEqual(["SOL", "BNB", "XRP", "AVAX"]);
    // The exact collision the registry exists to survive: one token, four Underlyings,
    // four distinct feeds.
    expect(new Set(cashSettled.map((u) => u.feed)).size).toBe(4);
  });

  it("resolves a feed however it is cased", () => {
    const eth = requireUnderlying("ETH");
    expect(underlyingForFeed(eth.feed.toUpperCase().replace("0X", "0x"))?.symbol).toBe("ETH");
  });

  it("refuses a symbol it does not carry, and says what it does", () => {
    expect(() => requireUnderlying("DOGE")).toThrow(UnknownUnderlying);
    expect(() => requireUnderlying("DOGE")).toThrow(/DOGE/);
    expect(() => requireUnderlying("DOGE")).toThrow(/BTC, ETH, SOL, BNB, XRP, AVAX/);
  });
});

describe("payout asset", () => {
  it("is a property of the Underlying, not of isCall", () => {
    // The bug this replaces: `isCall ? "WETH" : "USDC"` everywhere.
    expect(payoutAsset(requireUnderlying("ETH"), true)).toBe("WETH");
    expect(payoutAsset(requireUnderlying("BTC"), true)).toBe("WBTC");
    for (const symbol of ["SOL", "BNB", "XRP", "AVAX"]) {
      expect(payoutAsset(requireUnderlying(symbol), true), `${symbol} call`).toBe("USDC");
    }
  });

  it("is USDC for every put, on every Underlying", () => {
    for (const u of UNDERLYINGS) expect(payoutAsset(u, false), `${u.symbol} put`).toBe("USDC");
  });
});

describe("the single door", () => {
  it("takes the symbol being asked for and answers only that Underlying", async () => {
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 4.15, days: 1, symbol: "ETH" }),
      makeOrder({ nonce: 2, optionType: 1, strike: 77000, perContract: 900, days: 1, symbol: "BTC" }),
      makeOrder({ nonce: 3, optionType: 1, strike: 100, perContract: 2.1, days: 1, symbol: "SOL" }),
    ];

    expect((await buyableOrders("ETH")).map((o) => underlyingOf(o)?.symbol)).toEqual(["ETH"]);
    expect((await buyableOrders("BTC")).map((o) => underlyingOf(o)?.symbol)).toEqual(["BTC"]);
    expect((await buyableOrders("SOL")).map((o) => underlyingOf(o)?.symbol)).toEqual(["SOL"]);
  });

  it("separates the four cash-settled Underlyings despite one shared token", async () => {
    // Keyed by `underlyingToken` these four are one bucket, and a Trader asking for SOL
    // is shown BNB strikes at XRP prices. This is the test that fails if anyone
    // "simplifies" the feed lookup back to a token comparison.
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 100, perContract: 2.1, days: 1, symbol: "SOL" }),
      makeOrder({ nonce: 2, optionType: 1, strike: 680, perContract: 9.4, days: 1, symbol: "BNB" }),
      makeOrder({ nonce: 3, optionType: 1, strike: 1.36, perContract: 0.03, days: 1, symbol: "XRP" }),
      makeOrder({ nonce: 4, optionType: 1, strike: 7.2, perContract: 0.15, days: 1, symbol: "AVAX" }),
    ];

    // Every one of them reports the zero underlying token -- the collision is real here.
    expect(new Set(state.book.map((o) => o.order.underlyingToken))).toEqual(new Set([ZERO_ADDRESS]));

    for (const symbol of ["SOL", "BNB", "XRP", "AVAX"]) {
      const got = await buyableOrders(symbol);
      expect(got, `${symbol} should get exactly its own Order`).toHaveLength(1);
      expect(underlyingOf(got[0]!)?.symbol).toBe(symbol);
    }
  });

  it("excludes an Order whose feed is not on the allowlist -- not surfaced as unknown", async () => {
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 4.15, days: 1, symbol: "ETH" }),
      makeOrder({ nonce: 2, optionType: 1, strike: 42, perContract: 1, days: 1, feed: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    ];

    for (const symbol of SYMBOLS) {
      const got = await buyableOrders(symbol);
      expect(got.every((o) => underlyingOf(o) !== undefined), `${symbol} let an unregistered feed through`).toBe(true);
    }
    expect(await buyableOrders("ETH")).toHaveLength(1);
  });

  it("excludes an Order carrying no feed at all", async () => {
    state.book = [makeOrder({ nonce: 1, optionType: 1, strike: 2400, perContract: 4.15, days: 1, feed: null })];
    for (const symbol of SYMBOLS) expect(await buyableOrders(symbol)).toHaveLength(0);
  });

  it("refuses a symbol outside the registry rather than answering about ETH", async () => {
    await expect(buyableOrders("DOGE")).rejects.toThrow(UnknownUnderlying);
  });

  it("still never returns an Order the Trader would be the seller of", async () => {
    // ADR-0002. The registry is a new filter beside this one, never a replacement for it.
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 100, perContract: 2.1, days: 1, symbol: "SOL", isBuyer: false }),
      makeOrder({ nonce: 2, optionType: 1, strike: 101, perContract: 2.2, days: 1, symbol: "SOL" }),
    ];
    const got = await buyableOrders("SOL");
    expect(got).toHaveLength(1);
    expect(got[0]!.order.isBuyer).toBe(true);
  });

  it("still excludes non-USDC collateral on every Underlying", async () => {
    state.book = [
      makeOrder({ nonce: 1, optionType: 1, strike: 680, perContract: 9.4, days: 1, symbol: "BNB", collateral: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab" }),
    ];
    expect(await buyableOrders("BNB")).toHaveLength(0);
  });

  it("reads the feed off the Order the indexer actually sends", async () => {
    const order = makeOrder({ nonce: 1, optionType: 1, strike: 100, perContract: 2.1, days: 1, symbol: "SOL" });
    expect(feedOf(order)).toBe(FEED.SOL.toLowerCase());
  });
});

describe("spot price", () => {
  it("is looked up by symbol", async () => {
    expect(await spotPrice("ETH")).toBe(state.prices.ETH);
    expect(await spotPrice("BTC")).toBe(state.prices.BTC);
    expect(await spotPrice("XRP")).toBe(state.prices.XRP);
  });

  it("refuses a symbol outside the registry", async () => {
    await expect(spotPrice("DOGE")).rejects.toThrow(UnknownUnderlying);
  });

  it("throws rather than guessing when the feed quotes no price", async () => {
    delete (state.prices as Record<string, number | undefined>).AVAX;
    await expect(spotPrice("AVAX")).rejects.toThrow(/AVAX/);
  });
});
