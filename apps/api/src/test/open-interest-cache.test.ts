/**
 * The open interest cache -- the one place a slow indexer is allowed to be slow.
 *
 * `getBookState()` returns every Position the indexer has ever recorded and is bimodal:
 * measured against mainnet it answers in ~3 seconds for minutes at a time, then ~17-19
 * seconds for minutes at a time. Both `/deck` and `/depth` need the counts, both poll
 * every six seconds, and before this cache existed every navigation awaited that call --
 * so a Trader got a page that sometimes took 3 seconds and sometimes took 19, with
 * nothing on our side deciding which.
 *
 * What the cache promises is narrow and worth stating as tests: it blocks ONCE, when it
 * has nothing to serve, and never again. Everything below is a way of failing that.
 *
 * `getBookState` is not one of `stub-client`'s `spies`, so call counting is done here by
 * wrapping `getClient` -- the same seam `depth.test.ts` uses to make the indexer fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from "vitest";

vi.mock("../thetanuts/client.js", async () => await import("./stub-client.js"));

import * as client from "./stub-client.js";
import { resetStub } from "./stub-client.js";
import { NOW, makeBookPositions } from "./fixtures.js";
import {
  openInterest,
  openInterestOrEmpty,
  resetOpenInterestCache,
  OPEN_INTEREST_TTL_MS,
} from "../thetanuts/open-interest.js";
import { requireUnderlying } from "../thetanuts/underlyings.js";

// Date only, so the real timers a `flush()` needs still run.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => vi.useRealTimers());

const ETH = requireUnderlying("ETH");
const BTC = requireUnderlying("BTC");

/** Let every pending microtask and the background refresh actually land. */
const flush = () => new Promise((r) => setTimeout(r, 5));

/** How many times the indexer was asked, and what it answers with. */
let calls: number;
let answer: () => Promise<unknown>;

const THREE_AT_2400 = makeBookPositions([{ symbol: "ETH", strike: 2400, count: 3 }]);
const ONE_AT_2500 = makeBookPositions([{ symbol: "ETH", strike: 2500 }]);

beforeEach(() => {
  resetStub();
  resetOpenInterestCache();
  vi.setSystemTime(NOW);
  calls = 0;
  answer = async () => ({ positions: THREE_AT_2400 });

  // Captured BEFORE the spy is installed, or calling it inside would recurse.
  const original = client.getClient;
  vi.spyOn(client, "getClient").mockImplementation(() => {
    const real = original();
    return {
      ...real,
      api: {
        ...real.api,
        getBookState: async () => {
          calls++;
          return answer();
        },
      },
    };
  });
});

afterEach(() => vi.restoreAllMocks());

/** Move past the TTL without waiting 20 real seconds. */
const goStale = () => vi.setSystemTime(NOW + OPEN_INTEREST_TTL_MS + 1);

describe("the first read", () => {
  it("asks the indexer, because there is nothing to serve yet", async () => {
    const held = await openInterest(ETH);

    expect(calls).toBe(1);
    expect(held.get(2400)).toBe(3);
  });

  it("is shared by everyone who asks while it is running", async () => {
    // /deck and /depth both fire on one navigation. Without single-flighting, a cold
    // start makes two of the most expensive call in the app instead of one.
    answer = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { positions: THREE_AT_2400 };
    };

    const [deck, chart] = await Promise.all([openInterest(ETH), openInterest(ETH)]);

    expect(calls).toBe(1);
    expect(deck.get(2400)).toBe(3);
    expect(chart.get(2400)).toBe(3);
  });

  it("fills every Underlying at once, not just the one that asked", async () => {
    answer = async () => ({
      positions: makeBookPositions([
        { symbol: "ETH", strike: 2400, count: 2 },
        { symbol: "BTC", strike: 76000 },
      ]),
    });

    expect((await openInterest(ETH)).get(2400)).toBe(2);
    // The whole book was walked once. A second Underlying costs nothing.
    expect((await openInterest(BTC)).get(76000)).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("once it holds something", () => {
  it("never asks the indexer again inside the TTL", async () => {
    await openInterest(ETH);
    await openInterest(ETH);
    await openInterest(ETH);

    expect(calls).toBe(1);
  });

  it("answers a stale read immediately, with the count it already has", async () => {
    await openInterest(ETH);
    goStale();
    answer = async () => {
      // Slow enough that awaiting it would be obvious in the assertion below.
      await new Promise((r) => setTimeout(r, 50));
      return { positions: ONE_AT_2500 };
    };

    const held = await openInterest(ETH);

    // The OLD count, handed back without waiting for the refresh underneath it.
    expect(held.get(2400)).toBe(3);
    expect(held.get(2500)).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("picks up the refreshed count once it lands", async () => {
    await openInterest(ETH);
    goStale();
    answer = async () => ({ positions: ONE_AT_2500 });

    await openInterest(ETH);
    await flush();

    const held = await openInterest(ETH);
    expect(held.get(2500)).toBe(1);
    expect(held.get(2400)).toBeUndefined();
  });

  it("starts one refresh, not one per reader", async () => {
    await openInterest(ETH);
    goStale();
    answer = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { positions: ONE_AT_2500 };
    };

    await Promise.all([openInterest(ETH), openInterest(ETH), openInterest(ETH)]);

    // One cold read plus one refresh. Three stale readers must not mean three calls.
    expect(calls).toBe(2);
  });
});

describe("when the indexer will not answer", () => {
  it("keeps serving the last good count rather than emptying it", async () => {
    await openInterest(ETH);
    goStale();
    answer = async () => {
      throw new Error("indexer down");
    };

    const during = await openInterest(ETH);
    await flush();
    const after = await openInterest(ETH);

    // A blank means "nobody holds this" everywhere on the surface. A failed refresh must
    // never be spelled that way -- it would report a dead market as a fact.
    expect(during.get(2400)).toBe(3);
    expect(after.get(2400)).toBe(3);
  });

  it("does not reject, and does not leave an unhandled rejection behind", async () => {
    await openInterest(ETH);
    goStale();
    answer = async () => {
      throw new Error("indexer down");
    };

    await expect(openInterest(ETH)).resolves.toBeInstanceOf(Map);
    await flush();
  });

  it("stays cold when the FIRST read fails, so the next one tries again", async () => {
    answer = async () => {
      throw new Error("indexer down");
    };
    // Caching a failure would say "nobody holds this" for a full TTL.
    expect((await openInterestOrEmpty(ETH)).size).toBe(0);

    answer = async () => ({ positions: THREE_AT_2400 });
    expect((await openInterestOrEmpty(ETH)).get(2400)).toBe(3);
    expect(calls).toBe(2);
  });
});
