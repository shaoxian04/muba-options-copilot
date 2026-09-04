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
import { getAddress, Interface, Wallet } from "ethers";
import type { FastifyInstance } from "fastify";
import { getChainConfigById, type OrderWithSignature, type RFQRequest } from "@thetanuts-finance/thetanuts-client";
import { DEFAULT_BOOK, PRICES, previewFillOrder, calculatePayout } from "./fixtures.js";
import { __resetUpstreamCache } from "../thetanuts/upstream.js";

export const CHAIN_ID = 8453 as const;

/**
 * The real Base chain config, not a hand-written stand-in.
 *
 * `getChainConfigById` is a pure lookup with no RPC behind it, so a test can hold the
 * genuine token addresses, price feeds and implementation addresses without touching a
 * network. That matters for the RFQ path specifically: `assertSafeRfq` checks a built
 * request's collateral token and price feed against this product's own registry, and a
 * stub with invented addresses would make that check pass by accident in every test and
 * fail only on mainnet.
 */
const REAL_CHAIN = getChainConfigById(CHAIN_ID);

export const chain = {
  explorerUrl: "https://basescan.org",
  contracts: {
    optionBook: "0x0000000000000000000000000000000000000B00",
    optionFactory: REAL_CHAIN.contracts.optionFactory,
  },
  tokens: REAL_CHAIN.tokens,
  priceFeeds: REAL_CHAIN.priceFeeds,
  implementations: REAL_CHAIN.implementations,
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
  receipt: null | { status: number | null; to: string | null; logs?: readonly StubLog[] };
  /**
   * The fake sealed-bid auction, keyed by quotation id.
   *
   * Deliberately shaped like the two real sources the RFQ path reads: `quotation` is what
   * the CHAIN says (active, winner, minted option) and `offers` is what the INDEXER says.
   * A test that wants "a maker answered" seeds an offer; one that wants "the indexer is
   * down" sets `indexerDown`. Keeping the two apart in the stub is what lets a test prove
   * the route treats "no offers" and "cannot read offers" as different answers.
   */
  quotations: Map<string, StubQuotation>;
  /** The indexer is unreachable. Offers become unreadable; the chain reading is unaffected. */
  indexerDown: boolean;
  /**
   * Options minted by settling an RFQ, keyed by the address that holds them.
   *
   * A SECOND indexer, kept separate from `positions` on purpose: the protocol really does
   * have two, they really do not overlap, and a stub that merged them would let a board
   * reading only one of them pass every test here and show a Borrower nothing at all after
   * they bought a Cover.
   */
  rfqOptions: Record<string, { quotationId: string }[]>;
}

export interface StubLog {
  address: string;
  topics: string[];
  data: string;
}

export interface StubOffer {
  offeror: string;
  /** The premium, in USDC's 6 decimals. The total, not per contract. */
  amount: bigint;
  nonce: bigint;
  status?: string;
  /** Simulates a bid encrypted to somebody else's key: readable by nobody here. */
  undecryptable?: boolean;
}

export interface StubQuotation {
  isActive: boolean;
  optionContract: string;
  offers: StubOffer[];
  /**
   * The RFQ's own record, as the State API returns it -- the fields the BOARD reads, as
   * opposed to the fields the auction flow reads. Only tests about holdings need it.
   */
  record?: Record<string, unknown>;
}

/**
 * Backing fields for the upstream facts `upstream.ts` shares between callers.
 *
 * They sit behind accessors because a test that rewrites the fake chain mid-test -- and
 * several legitimately do, looping over six Underlyings and swapping the book each time --
 * must also invalidate whatever cached the previous answer. Doing it here rather than in
 * each test means a new test cannot forget.
 */
let _book: OrderWithSignature[] = [...DEFAULT_BOOK];
let _prices: Record<string, number> = { ...PRICES };
let _bookPositions: Record<string, unknown> = {};

/** What the fake chain currently looks like. Reset between tests. */
export const state: StubState = {
  get book() {
    return _book;
  },
  set book(v: OrderWithSignature[]) {
    _book = v;
    __resetUpstreamCache();
  },
  get prices() {
    return _prices;
  },
  set prices(v: Record<string, number>) {
    _prices = v;
    __resetUpstreamCache();
  },
  get bookPositions() {
    return _bookPositions;
  },
  set bookPositions(v: Record<string, unknown>) {
    _bookPositions = v;
    __resetUpstreamCache();
  },
  get spot() {
    return this.prices.ETH ?? null;
  },
  set spot(v: number | null) {
    if (v === null) delete this.prices.ETH;
    else this.prices.ETH = v;
    // A price written through the alias must invalidate too -- the setter above is
    // bypassed when a property of the existing object is mutated.
    __resetUpstreamCache();
  },
  canSign: false,
  positions: [] as unknown[],
  /** The wallet's current on-chain USDC allowance to the OptionBook, in 6 decimals. */
  allowance: 0n as bigint,
  /** What the stubbed provider says a transaction's receipt is. null = "not found yet". */
  receipt: null as null | { status: number | null; to: string | null; logs?: readonly StubLog[] },
  quotations: new Map<string, StubQuotation>(),
  indexerDown: false,
  rfqOptions: {} as Record<string, { quotationId: string }[]>,
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

  /**
   * A real `RFQRequest`, assembled the way the SDK assembles one.
   *
   * Not a token object: `assertSafeRfq` in `thetanuts/rfq/build.ts` checks the collateral
   * token, the price feed, the long flag, the zero collateral amount and the Reserve Price
   * on whatever comes back from here. A stub that returned `{}` would make every one of
   * those assertions vacuous, and they are the assertions that hold ADR-0002 on this path.
   *
   * The one place it simplifies: `strikes` and `numContracts` are converted with plain
   * arithmetic rather than the SDK's own helpers, which is what a stub is for.
   */
  buildRFQRequest: vi.fn((params: any): RFQRequest => {
    const decimals = REAL_CHAIN.tokens[params.collateralToken]?.decimals ?? 6;
    const strikes = (Array.isArray(params.strikes) ? params.strikes : [params.strikes]) as number[];
    const numContracts = BigInt(Math.round(params.numContracts * 10 ** decimals));
    const reserve =
      params.reservePrice === undefined
        ? 0n
        : BigInt(Math.round(params.reservePrice * params.numContracts * 10 ** decimals));
    return {
      params: {
        requester: params.requester,
        existingOptionAddress: "0x0000000000000000000000000000000000000000",
        collateral: REAL_CHAIN.tokens[params.collateralToken]!.address,
        collateralPriceFeed: REAL_CHAIN.priceFeeds[params.underlying]!,
        implementation:
          REAL_CHAIN.implementations[params.optionType === "CALL" ? "INVERSE_CALL" : "PUT"]!,
        strikes: strikes.map((k) => BigInt(Math.round(k * 1e8))),
        numContracts,
        requesterDeposit: 0n,
        // ALWAYS zero: collateral is pulled at settlement, never at request time.
        collateralAmount: 0n,
        expiryTimestamp: BigInt(params.expiry),
        offerEndTimestamp: BigInt(Math.floor(Date.now() / 1000) + params.offerDeadlineMinutes * 60),
        isRequestingLongPosition: params.isLong,
        convertToLimitOrder: false,
        extraOptionData: "0x",
      },
      tracking: { referralId: 0n, eventCode: 0n },
      reservePrice: reserve,
      requesterPublicKey: params.requesterPublicKey ?? "",
    };
  }),

  // Real hex for the same reason `encodeApprove` is: this calldata reaches a real
  // `ethers.sendTransaction` in the browser suite, which validates `data` as actual bytes.
  encodeRequestForQuotation: vi.fn((_request: RFQRequest) => ({
    to: chain.contracts.optionFactory,
    data: "0xa1b2c3d4",
  })),
  encodeSettleQuotationEarly: vi.fn((id: bigint, amount: bigint, _nonce: bigint, _offeror: string) => ({
    to: chain.contracts.optionFactory,
    data: `0xdeadbeef${id.toString(16).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
  })),
  encodeCancelQuotation: vi.fn((id: bigint) => ({
    to: chain.contracts.optionFactory,
    data: `0xfeedface${id.toString(16).padStart(64, "0")}`,
  })),
  getQuotation: vi.fn(async (id: bigint) => {
    const q = state.quotations.get(id.toString());
    return {
      params: {},
      state: {
        isActive: q?.isActive ?? false,
        currentWinner: "0x0000000000000000000000000000000000000000",
        currentBestPriceOrReserve: 0n,
        feeCollected: 0n,
        optionContract: q?.optionContract ?? "0x0000000000000000000000000000000000000000",
      },
    };
  }),
  getUserPositionsFromIndexer: vi.fn(async (_address: string) => state.positions),
  getUserOptionsFromRfq: vi.fn(async (address: string) => state.rfqOptions[address.toLowerCase()] ?? []),
  getRfq: vi.fn(async (id: string) => {
    if (state.indexerDown) throw new Error("indexer unreachable");
    const q = state.quotations.get(id);
    if (!q) throw new Error(`no such quotation: ${id}`);
    const offers = Object.fromEntries(
      (q?.offers ?? []).map((o, i) => [
        String(i),
        {
          offeror: o.offeror,
          signingKey: o.undecryptable ? "0xUNREADABLE" : "0xMAKERKEY",
          // The stub's "encryption" is the plain amount and nonce -- `decryptOffer` below
          // is its inverse. Faking the cipher rather than the flow keeps the test honest
          // about what it is proving: the route's handling of bids, not ECDH.
          signedOfferForRequester: `${o.amount}:${o.nonce}`,
          status: o.status ?? "pending",
        },
      ])
    );
    // `record` is whatever a test seeded about the RFQ itself -- the feed, the size, the
    // winning price. Absent for an auction-only fixture, which is every test that only
    // cares about the offer flow.
    return { id, offers, ...(q.record ?? {}) };
  }),
  generateKeyPair: vi.fn(() => ({
    privateKey: "0x" + "a".repeat(64),
    compressedPublicKey: "0x02" + "b".repeat(64),
    publicKey: "0x04" + "b".repeat(128),
  })),
  decryptOffer: vi.fn(async (payload: string, signingKey: string) => {
    if (signingKey === "0xUNREADABLE") throw new Error("not encrypted to this key");
    const [amount, nonce] = payload.split(":");
    return { offerAmount: BigInt(amount!), nonce: BigInt(nonce!) };
  }),
};

export function resetStub(): void {
  // Resetting the fake upstream without clearing what cached its answers would hand the
  // next test the previous test's book. `upstream.ts` shares reads across callers by
  // design (audit D1/D2), and module state outlives a single `it`.
  __resetUpstreamCache();
  state.book = [...DEFAULT_BOOK];
  state.prices = { ...PRICES };
  state.canSign = false;
  state.positions = [];
  state.bookPositions = {};
  state.allowance = 0n;
  state.receipt = null;
  state.quotations = new Map();
  state.indexerDown = false;
  state.rfqOptions = {};
  for (const spy of Object.values(spies)) spy.mockClear();
}

export function getClient(): any {
  return {
    api: {
      fetchOrders: spies.fetchOrders,
      getMarketData: spies.getMarketData,
      getUserPositionsFromIndexer: spies.getUserPositionsFromIndexer,
      getBookState: async () => ({ positions: state.bookPositions }),
      getRfq: spies.getRfq,
      getUserOptionsFromRfq: spies.getUserOptionsFromRfq,
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
    optionFactory: {
      buildRFQRequest: spies.buildRFQRequest,
      encodeRequestForQuotation: spies.encodeRequestForQuotation,
      encodeSettleQuotationEarly: spies.encodeSettleQuotationEarly,
      encodeCancelQuotation: spies.encodeCancelQuotation,
      getQuotation: spies.getQuotation,
    },
    rfqKeys: {
      generateKeyPair: spies.generateKeyPair,
      decryptOffer: spies.decryptOffer,
    },
    utils: { calculatePayout },
    provider: { getTransactionReceipt: spies.getTransactionReceipt },
  };
}

export const canSign = (): boolean => state.canSign;

/**
 * Receipts carrying REAL, ABI-encoded factory events.
 *
 * `thetanuts/rfq/verify.ts` parses these with an `ethers.Interface`, so a hand-written
 * `{ topics: ["QuotationRequested"] }` would be rejected by the parser rather than read.
 * Encoding them properly means the test exercises the actual decode -- including the
 * address filter that stops a log from some other contract being read as the factory's.
 */
const factoryEvents = new Interface([
  "event QuotationRequested(uint256 indexed quotationId, address indexed requester, uint256 reservePrice, string requesterPublicKey)",
  "event QuotationSettled(uint256 indexed quotationId, address indexed requester, address indexed winner, address optionAddress)",
]);

function factoryLog(name: string, args: unknown[]): StubLog {
  const encoded = factoryEvents.encodeEventLog(name, args);
  return { address: chain.contracts.optionFactory, topics: [...encoded.topics], data: encoded.data };
}

/** A successful `requestForQuotation`, as the chain would report it. */
export const openedReceipt = (quotationId: bigint, requester: string = TRADER_ADDRESS) => ({
  status: 1,
  to: chain.contracts.optionFactory,
  logs: [factoryLog("QuotationRequested", [quotationId, requester, 0n, "0x02"])],
});

/** A successful `settleQuotationEarly`, with the option it minted. */
export const settledReceipt = (
  quotationId: bigint,
  optionAddress: string,
  requester: string = TRADER_ADDRESS
) => ({
  status: 1,
  to: chain.contracts.optionFactory,
  logs: [
    factoryLog("QuotationSettled", [quotationId, requester, MAKER_ADDRESS, optionAddress]),
  ],
});

/**
 * A maker. Used only to prove its address never reaches a response.
 *
 * Run through `getAddress` because the event encoder validates checksums -- a hand-typed
 * mixed-case address throws inside the ABI coder rather than in the assertion, which is a
 * confusing way to learn that a test fixture was malformed.
 */
export const MAKER_ADDRESS = getAddress("0x00000000000000000000000000000000000000ee");

/**
 * A REAL wallet (a fixed, well-known test key -- never a funded one) so tests can both
 * claim this address AND produce a signature that actually verifies against it, driving
 * /auth/challenge + /auth/verify for real rather than mocking the crypto.
 */
export const TRADER_WALLET = new Wallet("0x" + "1".repeat(64));
export const TRADER_ADDRESS = TRADER_WALLET.address;
export const walletAddress = (): string | null => (state.canSign ? TRADER_ADDRESS : null);

/**
 * Drives the challenge/verify round trip so a test's session may then use /fill/prepare.
 * `accountToken`, when given, is sent as `x-account-token` on both calls -- required
 * since /auth/challenge and /auth/verify themselves now require a signed-in account.
 */
export async function proveWallet(
  app: FastifyInstance,
  session: string,
  address: string = TRADER_ADDRESS,
  accountToken?: string
): Promise<void> {
  const headers: Record<string, string> = { "x-session-id": session };
  if (accountToken) headers["x-account-token"] = accountToken;

  const challenge = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    headers,
    payload: { walletAddress: address },
  });
  const { message } = challenge.json() as { message: string };
  const signature = await TRADER_WALLET.signMessage(message);
  await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers,
    payload: { signature },
  });
}
