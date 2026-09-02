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
import { Wallet } from "ethers";
import type { FastifyInstance } from "fastify";
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
  /** The wallet's current on-chain USDC allowance to the OptionBook, in 6 decimals. */
  allowance: bigint;
  /** What the stubbed provider says a transaction's receipt is. null = "not found yet". */
  receipt: null | { status: number | null; to: string | null };
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
  positions: [] as unknown[],
  bookPositions: {},
  /** The wallet's current on-chain USDC allowance to the OptionBook, in 6 decimals. */
  allowance: 0n as bigint,
  /** What the stubbed provider says a transaction's receipt is. null = "not found yet". */
  receipt: null as null | { status: number | null; to: string | null },
};

/** Anything that would have moved money. Asserted on, never expected to fire. */
export const spies = {
  fillOrder: vi.fn(async (_o: OrderWithSignature, _amount: bigint) => ({ hash: "0xTXHASH" })),
  ensureAllowance: vi.fn(async (_token: string, _spender: string, _amount: bigint) => undefined),
  fetchOrders: vi.fn(async () => state.book),
  getMarketData: vi.fn(async () => ({ prices: { ...state.prices } })),
  previewFillOrder: vi.fn(previewFillOrder),
  getAllowance: vi.fn(async (_token: string, _owner: string, _spender: string) => state.allowance),
  // Real hex, not a readable placeholder: this calldata is captured into the browser
  // suite's fixtures and fed to a REAL `ethers.sendTransaction` there, which validates
  // `data` as actual bytes -- "0xapprove:..." passed every backend assertion here but
  // broke on arrival in a real wallet call, which is exactly the gap that caught it.
  encodeApprove: vi.fn((token: string, spender: string, amount: bigint) => ({
    to: token,
    data: `0x095ea7b3${spender.replace(/^0x/, "").padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
  })),
  encodeFillOrder: vi.fn((_order: OrderWithSignature, amount: bigint) => ({
    to: chain.contracts.optionBook,
    data: `0x12345678${amount.toString(16).padStart(64, "0")}`,
  })),
  getTransactionReceipt: vi.fn(async (_txHash: string) => state.receipt),
};

export function resetStub(): void {
  state.book = [...DEFAULT_BOOK];
  state.prices = { ...PRICES };
  state.canSign = false;
  state.positions = [];
  state.bookPositions = {};
  state.allowance = 0n;
  state.receipt = null;
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
      encodeFillOrder: spies.encodeFillOrder,
    },
    erc20: {
      ensureAllowance: spies.ensureAllowance,
      getAllowance: spies.getAllowance,
      encodeApprove: spies.encodeApprove,
    },
    utils: { calculatePayout },
    provider: { getTransactionReceipt: spies.getTransactionReceipt },
  };
}

export const canSign = (): boolean => state.canSign;

/**
 * A REAL wallet (a fixed, well-known test key -- never a funded one) so tests can both
 * claim this address AND produce a signature that actually verifies against it, driving
 * /auth/challenge + /auth/verify for real rather than mocking the crypto.
 */
export const TRADER_WALLET = new Wallet("0x" + "1".repeat(64));
export const TRADER_ADDRESS = TRADER_WALLET.address;
export const walletAddress = (): string | null => (state.canSign ? TRADER_ADDRESS : null);

/** Drives the challenge/verify round trip so a test's session may then use /fill/prepare. */
export async function proveWallet(
  app: FastifyInstance,
  session: string,
  address: string = TRADER_ADDRESS
): Promise<void> {
  const challenge = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    headers: { "x-session-id": session },
    payload: { walletAddress: address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await TRADER_WALLET.signMessage(message);
  await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "x-session-id": session },
    payload: { signature },
  });
}
