/**
 * The book's upstream boundary, validated (audit F1).
 *
 * Inbound HTTP is checked rigorously -- a zod schema on every route, query and body. The
 * data coming the OTHER way had none: the whole book rested on three fields reached
 * through `any` casts (`rawApiData.priceFeed`, `rawApiData.greeks.iv`, and
 * `api.getBookState?.()`, called with optional chaining so its disappearance is not even
 * a runtime error).
 *
 * The failure mode was silent and total. If the indexer renames `priceFeed`, `feedOf`
 * returns "", `underlyingForFeed("")` returns undefined, `passesTheDoor` is false for
 * every Order, and `buyableOrders` hands back an empty array -- so the Trader is shown
 * "No maker is quoting this right now", the carefully-written market-condition message,
 * for a complete integration failure. Nothing logs and nothing alerts.
 *
 * The distinction that matters here is between ONE odd Order (skip it, as before -- a
 * single malformed record must not cost a Trader the whole book) and the SHAPE having
 * changed (refuse loudly). "We fetched Orders and not one of them carried a readable
 * price feed" is the unambiguous second case.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import { buyableOrders, buyableEverywhere, UpstreamShapeChanged } from "../thetanuts/orders.js";
import { resetStub, state } from "./stub-client.js";
import { makeOrder } from "./fixtures.js";

beforeEach(() => resetStub());

/** A well-formed put on ETH. `feed: null` is the factory's way of saying "no price feed". */
const put = (strike: number, extra: Record<string, unknown> = {}) =>
  makeOrder({ nonce: 1, optionType: 1, strike, perContract: 4.15, days: 1, ...extra });

/** A book of `n` Orders, every one of them unreadable -- what a renamed field looks like. */
const allFeedless = (n: number) => Array.from({ length: n }, (_, i) => put(2400 + i * 20, { feed: null }));

describe("a book whose shape has changed refuses loudly", () => {
  it("throws rather than reporting an empty book when no Order carries a price feed", async () => {
    state.book = allFeedless(8);

    // The whole point: NOT an empty array, which reads to a Trader as "no maker is
    // quoting" and to an operator as nothing at all.
    await expect(buyableOrders("ETH")).rejects.toBeInstanceOf(UpstreamShapeChanged);
  });

  it("throws on the cross-asset read too, which feeds the ticker rail", async () => {
    state.book = allFeedless(8);
    await expect(buyableEverywhere()).rejects.toBeInstanceOf(UpstreamShapeChanged);
  });

  it("names the field that went missing, so the log says what to fix", async () => {
    state.book = allFeedless(8);
    await expect(buyableOrders("ETH")).rejects.toThrow(/priceFeed/);
  });
});

describe("a sample too small to mean anything keeps the old behaviour", () => {
  it("excludes a lone unreadable Order rather than calling it an outage", async () => {
    // One malformed record genuinely happens and tells us nothing about the contract.
    // This is the case underlyings.test.ts pins: the door filters it out, quietly.
    state.book = [put(2400, { feed: null })];
    await expect(buyableOrders("ETH")).resolves.toEqual([]);
  });
});

describe("an ordinary empty book is still an ordinary empty book", () => {
  it("returns empty without throwing when the indexer genuinely has no Orders", async () => {
    // Nobody is quoting. A real market condition, and the message about maker liquidity
    // renewing at 09:00 UTC is the correct answer.
    state.book = [];
    await expect(buyableOrders("ETH")).resolves.toEqual([]);
  });

  it("returns empty without throwing when Orders exist but none is on this Underlying", async () => {
    // Every Order is well-formed and readable; they are simply all on ETH.
    state.book = [put(2400)];
    await expect(buyableOrders("SOL")).resolves.toEqual([]);
  });

  it("does not mistake an unregistered feed for a shape change", async () => {
    // A feed the allowlist does not carry is a real, readable Order we choose to exclude
    // (ADR-0010) -- not evidence the indexer changed.
    state.book = [put(2400, { feed: "0x00000000000000000000000000000000deadbeef" })];
    await expect(buyableOrders("ETH")).resolves.toEqual([]);
  });
});

describe("one malformed Order does not cost a Trader the book", () => {
  it("skips the unreadable Order and keeps the readable ones", async () => {
    state.book = [put(2400), put(2440, { feed: null })];

    const orders = await buyableOrders("ETH");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.order.strikes![0]).toBe(put(2400).order.strikes![0]);
  });
});
