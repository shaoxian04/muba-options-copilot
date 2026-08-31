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
import { DEFAULT_BOOK, SPOT, previewFillOrder, calculatePayout } from "./fixtures.js";

export const CHAIN_ID = 8453 as const;

export const chain = {
  explorerUrl: "https://basescan.org",
  contracts: { optionBook: "0x0000000000000000000000000000000000000B00" },
} as any;

/** What the fake chain currently looks like. Reset between tests. */
export const state = {
  book: [...DEFAULT_BOOK] as OrderWithSignature[],
  spot: SPOT as number | null,
  canSign: false,
  positions: [] as unknown[],
};

/** Anything that would have moved money. Asserted on, never expected to fire. */
export const spies = {
  fillOrder: vi.fn(async (_o: OrderWithSignature, _amount: bigint) => ({ hash: "0xTXHASH" })),
  ensureAllowance: vi.fn(async (_token: string, _spender: string, _amount: bigint) => undefined),
  fetchOrders: vi.fn(async () => state.book),
  getMarketData: vi.fn(async () => ({ prices: { ETH: state.spot } })),
  previewFillOrder: vi.fn(previewFillOrder),
};

export function resetStub(): void {
  state.book = [...DEFAULT_BOOK];
  state.spot = SPOT;
  state.canSign = false;
  state.positions = [];
  for (const spy of Object.values(spies)) spy.mockClear();
}

export function getClient(): any {
  return {
    api: {
      fetchOrders: spies.fetchOrders,
      getMarketData: spies.getMarketData,
      getUserPositionsFromIndexer: async () => state.positions,
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
