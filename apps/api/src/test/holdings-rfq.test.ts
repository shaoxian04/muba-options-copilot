/**
 * The board reads BOTH indexers.
 *
 * Thetanuts has two, and they do not overlap: the OptionBook's, which knows what was
 * filled against a resting Order, and the OptionFactory's State API, which knows what was
 * minted by settling a sealed-bid request. Every Cover and every custom strike lands in
 * the second one (ADR-0017).
 *
 * A board reading only the first is not obviously broken -- it renders, it is fast, and
 * it is empty. A Borrower who has just bought a Cover, at the exact moment they most want
 * to see it, is told they hold nothing. That is the failure this file exists to catch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resetStub, spies, state, TRADER_ADDRESS } from "./stub-client.js";
import { UNDERLYINGS } from "../thetanuts/underlyings.js";

const ETH_FEED = UNDERLYINGS.find((u) => u.symbol === "ETH")!.feed;
const BTC_FEED = UNDERLYINGS.find((u) => u.symbol === "BTC")!.feed;

const inDays = (n: number) => Math.floor(Date.now() / 1000) + n * 86_400;

let app: FastifyInstance;

beforeEach(async () => {
  resetStub();
  app = await buildApp();
});

/**
 * A settled Cover: a 1.66-contract ETH put struck at $1,987.95, bought for $1.25.
 *
 * The units are the State API's, not ours: strikes in 8 decimals, `numContracts` and
 * `currentBestPrice` in the collateral's 6. Getting those wrong is the single most likely
 * bug in this mapping, so the fixture states them the way the wire does rather than the
 * way the assertion would like them.
 */
function seedCover(over: Record<string, unknown> = {}, id = "7") {
  state.rfqOptions[TRADER_ADDRESS.toLowerCase()] = [{ quotationId: id }];
  state.quotations.set(id, {
    isActive: false,
    optionContract: "0x00000000000000000000000000000000000000aa",
    offers: [],
    record: {
      requester: TRADER_ADDRESS,
      isRequestingLongPosition: true,
      collateralPriceFeed: ETH_FEED,
      strikes: [String(1987.95 * 1e8)],
      numContracts: String(Math.round(1.66 * 1e6)),
      currentBestPrice: String(Math.round(1.25 * 1e6)),
      expiryTimestamp: inDays(14),
      createdAt: Math.floor(Date.now() / 1000),
      optionType: 1, // PUT
      ...over,
    },
  });
}

const board = async () => (await app.inject({ method: "GET", url: `/positions?address=${TRADER_ADDRESS}` })).json();

describe("GET /positions -- options minted by an RFQ", () => {
  it("shows a bought Cover, with the premium a maker actually charged", async () => {
    seedCover();
    const body = await board();

    expect(body.holdings).toHaveLength(1);
    const [h] = body.holdings;
    expect(h.kind).toBe("REAL");
    expect(h.strike.display).toBe("$1,987.95");
    expect(h.contracts.display).toBe("1.660000");
    // The winning bid, not the $8 Reserve Price. Buy-only makes Max Loss exactly it.
    expect(h.premiumUsdc.display).toBe("$1.25");
    expect(h.maxLossUsdc.display).toBe("$1.25");
    expect(h.direction).toBe("DOWN");
  });

  it("reads both indexers, and shows what each holds", async () => {
    seedCover();
    state.positions = [
      {
        side: "buyer",
        amount: String(1 * 1e6),
        entryPrice: String(2 * 1e6),
        entryTimestamp: Math.floor(Date.now() / 1000),
        option: { strikes: [String(2400 * 1e8)], expiry: inDays(3), optionType: 1, priceFeed: ETH_FEED },
      },
    ];

    const body = await board();
    expect(body.holdings).toHaveLength(2);
    expect(spies.getUserOptionsFromRfq).toHaveBeenCalled();
  });

  it("keeps the board alive when one indexer refuses, rather than losing both", async () => {
    seedCover();
    spies.getUserPositionsFromIndexer.mockRejectedValueOnce(new Error("book indexer down"));

    const body = await board();
    // The Cover survives the other indexer failing. A board that dropped everything
    // because one source blinked would tell a Borrower they hold nothing.
    expect(body.holdings).toHaveLength(1);
    expect(body.address).toBe(TRADER_ADDRESS);
  });

  it("says it knows nothing, rather than nothing is held, when both refuse", async () => {
    seedCover();
    spies.getUserPositionsFromIndexer.mockRejectedValueOnce(new Error("down"));
    spies.getUserOptionsFromRfq.mockRejectedValueOnce(new Error("also down"));

    const body = await board();
    expect(body.holdings).toHaveLength(0);
    // A null address is how the board distinguishes "we could not look" from "nothing there".
    expect(body.address).toBeNull();
  });

  it("omits an expired option -- a board is what you hold now, and a lapsed Cover is not", async () => {
    seedCover({ expiryTimestamp: inDays(-1) });
    expect((await board()).holdings).toHaveLength(0);
  });

  it("omits a request this address did not make", async () => {
    seedCover({ requester: "0x00000000000000000000000000000000000000Bb" });
    expect((await board()).holdings).toHaveLength(0);
  });

  it("omits a short request -- there is no honest Max Loss to put beside one (ADR-0002)", async () => {
    seedCover({ isRequestingLongPosition: false });
    expect((await board()).holdings).toHaveLength(0);
  });

  it("values a BTC Cover against BTC's own spot, never ETH's", async () => {
    // The bug this guards is silent: a BTC holding marked at ETH's spot reads
    // `max(0, 2450 - 77000)` -- zero, on a holding that may be deep in the money.
    seedCover({ collateralPriceFeed: BTC_FEED, strikes: [String(90_000 * 1e8)] });
    const [h] = (await board()).holdings;

    // BTC spot is $77,882 in the fixtures; a $90,000 put is $12,118 in the money per
    // contract, times 1.66 contracts.
    expect(h.currentValueUsdc.value).toBeGreaterThan(0);
    expect(h.strike.display).toBe("$90,000.00");
  });

  it("drops one unreadable RFQ without losing the others", async () => {
    seedCover();
    state.rfqOptions[TRADER_ADDRESS.toLowerCase()] = [{ quotationId: "7" }, { quotationId: "does-not-exist" }];
    expect((await board()).holdings).toHaveLength(1);
  });
});
