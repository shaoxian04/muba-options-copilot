/**
 * The Thetanuts client, stubbed at its module boundary.
 *
 * Every test substitutes this for `thetanuts/client.js`, which is the only module in
 * the backend that holds an RPC connection and a signing key. Stubbing exactly there
 * means no test can reach the network, the chain or a wallet -- and it means nothing
 * else had to be designed for testability to make that true.
 *
 * `fillOrder` and `ensureAllowance` are spies rather than throws, deliberately: a test
 * that asserts a route never spends money needs to be able to see that it did, and a
 * throw would be caught by the route and reported as an ordinary failure.
 */
import { vi } from "vitest";
import type { OrderWithSignature } from "@thetanuts-finance/thetanuts-client";
import { DEFAULT_BOOK, PRICES, previewFillOrder, calculatePayout } from "./fixtures.js";

export const CHAIN_ID = 8453 as const;

export const chain = {
  explorerUrl: "https://basescan.org",
  contracts: { optionBook: "0x0000000000000000000000000000000000000B00" },
} as any;

interface StubState {
  book: OrderWithSignature[];
  /**
   * Spot for every Underlying, as market data returns it. A test that deletes a key here
   * is asking what happens when a feed quotes nothing -- which must be a refusal, never
   * a guess.
   */
  prices: Record<string, number | undefined>;
  /**
   * ETH spot, for the tests written before the book had six Underlyings.
   *
   * An accessor over `prices.ETH` rather than a second field: two copies of one number
   * is how a suite ends up asserting against a spot the code never read.
   */
  spot: number | null;
  canSign: boolean;
  positions: unknown[];
  /**
   * Every Position the indexer has ever recorded, as `getBookState` returns them --
   * keyed by address, and mostly settled. Open interest is the `active` ones, which is
   * the distinction a test that seeded "some positions" would miss.
   */
  bookPositions: Record<string, unknown>;
}

/** What the fake chain currently looks like. Reset between tests. */
export const state: StubState = {
  book: [...DEFAULT_BOOK],
  prices: { ...PRICES },
  get spot() {
    return this.prices.ETH ?? null;
  },
  set spot(v: number | null) {
    if (v === null) delete this.prices.ETH;
    else this.prices.ETH = v;
  },
  canSign: false,
  positions: [],
  bookPositions: {},
};

/** Anything that would have moved money. Asserted on, never expected to fire. */
export const spies = {
  fillOrder: vi.fn(async (_o: OrderWithSignature, _amount: bigint) => ({ hash: "0xTXHASH" })),
  ensureAllowance: vi.fn(async (_token: string, _spender: string, _amount: bigint) => undefined),
  fetchOrders: vi.fn(async () => state.book),
  getMarketData: vi.fn(async () => ({ prices: { ...state.prices } })),
  previewFillOrder: vi.fn(previewFillOrder),
};

export function resetStub(): void {
  state.book = [...DEFAULT_BOOK];
  state.prices = { ...PRICES };
  state.canSign = false;
  state.positions = [];
  state.bookPositions = {};
  for (const spy of Object.values(spies)) spy.mockClear();
}

export function getClient(): any {
  return {
    api: {
      fetchOrders: spies.fetchOrders,
      getMarketData: spies.getMarketData,
      getUserPositionsFromIndexer: async () => state.positions,
      getBookState: async () => ({ positions: state.bookPositions }),
    },
    optionBook: {
      previewFillOrder: spies.previewFillOrder,
      fillOrder: spies.fillOrder,
    },
    erc20: { ensureAllowance: spies.ensureAllowance },
    utils: { calculatePayout },
  };
}

export const canSign = (): boolean => state.canSign;

export const TRADER_ADDRESS = "0x1111111111111111111111111111111111111111";
export const walletAddress = (): string | null => (state.canSign ? TRADER_ADDRESS : null);
