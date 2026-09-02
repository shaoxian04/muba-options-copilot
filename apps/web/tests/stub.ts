/**
 * The API, stubbed at the network.
 *
 * Stubbed at the NETWORK rather than in application code, deliberately. Two of the
 * things this suite has to prove are claims about traffic -- that a Practice Run issues
 * no request to `/fill`, and that no response the browser receives carries a maker
 * address, nonce or signature -- and neither is checkable if the requests never leave
 * the page.
 *
 * The bodies come from `tests/fixtures/`, which the real Fastify app generated. Nothing
 * in here invents an API response, so a contract change breaks the fixture test in the
 * API suite rather than quietly leaving these tests passing against a fiction.
 */
import type { Page, Request, Route } from "@playwright/test";

import deckDown1 from "./fixtures/deck-down-1.json" with { type: "json" };
import deckDown2 from "./fixtures/deck-down-2.json" with { type: "json" };
import deckDown3 from "./fixtures/deck-down-3.json" with { type: "json" };
import deckUp1 from "./fixtures/deck-up-1.json" with { type: "json" };
import deckEmpty from "./fixtures/deck-empty.json" with { type: "json" };
import deckCompressed from "./fixtures/deck-compressed.json" with { type: "json" };
import deckSolDown1 from "./fixtures/deck-sol-down-1.json" with { type: "json" };
import deckSolDown2 from "./fixtures/deck-sol-down-2.json" with { type: "json" };
import deckSolUp1 from "./fixtures/deck-sol-up-1.json" with { type: "json" };
import markets from "./fixtures/markets.json" with { type: "json" };
import depthEth from "./fixtures/depth-eth.json" with { type: "json" };
import depthEthMarked from "./fixtures/depth-eth-marked.json" with { type: "json" };
import session from "./fixtures/session.json" with { type: "json" };
import positionsEmpty from "./fixtures/positions-empty.json" with { type: "json" };
import positionsAfterPractice from "./fixtures/positions-after-practice.json" with { type: "json" };
import proposeAgent from "./fixtures/propose-agent.json" with { type: "json" };
import proposeByCard from "./fixtures/propose-by-card.json" with { type: "json" };
import practiceResult from "./fixtures/practice.json" with { type: "json" };
import fillPrepare from "./fixtures/fill-prepare.json" with { type: "json" };
import authChallenge from "./fixtures/auth-challenge.json" with { type: "json" };
import veto from "./fixtures/veto.json" with { type: "json" };
import noOrder from "./fixtures/no-order.json" with { type: "json" };
import refusal from "./fixtures/refusal.json" with { type: "json" };

export const API = "http://127.0.0.1:3001";

/**
 * The token the suite builds the app with, and the one the stub demands on the gated
 * routes -- `/fill` and `/propose`.
 *
 * The documented security posture has `COPILOT_API_TOKEN` set, so that is the
 * configuration the tests run in -- the alternative is a suite that only ever exercises
 * the unguarded case and passes happily while Confirm 401s for everyone who read the
 * README. Not a secret: it never leaves this repo.
 */
export const TEST_API_TOKEN = "surface-suite-token";

/**
 * The moment the fixture book was quoted at.
 *
 * The fixtures were generated under a fake clock, so their expiries are fixed points in
 * January 2026. Left alone, every countdown on the surface would render 00:00:00 and
 * every time bar would be empty -- the tests would be looking at an expired Deck. So the
 * browser's clock is moved to the same instant, which also makes the countdowns
 * deterministic: they advance exactly as far as a test asks them to and not one tick
 * further.
 */
export const FIXTURE_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

export const fixtures = {
  deckDown1,
  deckSolDown1,
  deckSolDown2,
  deckSolUp1,
  markets,
  deckUp1,
  deckCompressed,
  session,
  proposeAgent,
  proposeByCard: proposeByCard as Record<string, any>,
  veto,
  practiceResult,
  positionsAfterPractice,
  fillPrepare,
  authChallenge,
  depthEth,
  depthEthMarked,
};

/** Longest shot first, so index 0 is the leftmost Card in the row. */
export const cards = deckDown1.cards;

/**
 * "deep-budget" (issue #30): a Risk Budget generous enough that every fixture Card's
 * $500 Maker Depth is the smaller of the two, so the confirmation's size cap binds on
 * DEPTH instead of budget -- the opposite branch from every other scenario here, where
 * the $5 default budget is always the tighter ceiling.
 */
export type Scenario =
  | "normal"
  | "veto"
  | "no-order"
  | "empty"
  | "compressed"
  | "over-budget"
  | "settle-fails"
  | "settle-pending-once"
  | "depth-marked"
  | "deep-budget";

export interface Traffic {
  /** Every request the page made to the API, in order. */
  all: Request[];
  paths: () => string[];
  /** Every response body the browser was handed, for the leak check. */
  bodies: string[];
  /**
   * Reprice the book under the Trader's feet.
   *
   * Every Deck served from now on quotes a different premium, which is what "the quote
   * moved" actually is: the Trader is holding a proposal the market no longer agrees
   * with. The surface has to notice on its next poll and say so BEFORE they confirm.
   */
  moveTheQuote: () => void;
  /**
   * Issue #32 -- hold the NEXT response to `pathname` open until the test releases it.
   *
   * The loading states this ticket is about only exist for the width of one network
   * round trip, which a local stub answers instantly -- too fast for Playwright to ever
   * observe. This makes that window as wide as a test needs: the held request sits
   * unanswered until the returned function is called, so a test can assert on the
   * loading affordance in between. Only the next matching request is held; the one
   * after it answers normally, the same way a real slow request eventually completes.
   */
  hold: (pathname: string) => () => void;
}

const json = (route: Route, body: unknown, traffic: Traffic, status = 200) => {
  const text = JSON.stringify(body);
  traffic.bodies.push(text);
  return route.fulfill({ status, contentType: "application/json", body: text });
};

const authorised = (request: Request) => request.headers()["authorization"] === `Bearer ${TEST_API_TOKEN}`;

/** The fake account every signed-in journey uses (ADR-0013). */
export const FAKE_ACCOUNT_TOKEN = "fake-account-token";
const accountAuthorised = (request: Request) => request.headers()["x-account-token"] === FAKE_ACCOUNT_TOKEN;

/**
 * Simulates a signed-in Supabase session directly in `localStorage`, in the shape
 * `@supabase/supabase-js`'s browser client persists one under -- this is what lets a
 * Playwright test start "already signed in" without actually driving the /login page's
 * real Supabase calls (which would need a real project reachable from CI). Never
 * contacts a real Supabase project, real project ID, or real user account.
 */
export async function signIn(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, token }: { url: string; token: string }) => {
      const projectRef = new URL(url).hostname.split(".")[0];
      window.localStorage.setItem(
        `sb-${projectRef}-auth-token`,
        JSON.stringify({
          access_token: token,
          refresh_token: "fake-refresh-token",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: "bearer",
          user: { id: "fixture-user", email: "fixture@example.com" },
        })
      );
    },
    { url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://fixture.supabase.co", token: FAKE_ACCOUNT_TOKEN }
  );
}

/**
 * The Deck for whatever was asked for.
 *
 * Keyed on `asset` first, because the surface asking for the wrong Underlying and being
 * handed an ETH Deck anyway is precisely the failure the required parameter exists to
 * prevent -- a stub that ignored it would let that bug through.
 */
const deckFor = (url: URL) => {
  const asset = url.searchParams.get("asset");
  const direction = url.searchParams.get("direction");
  const days = url.searchParams.get("horizonDays");
  if (asset === "SOL") {
    if (direction === "UP") return deckSolUp1;
    return days === "2" ? deckSolDown2 : deckSolDown1;
  }
  if (direction === "UP") return deckUp1;
  if (days === "2") return deckDown2;
  if (days === "3") return deckDown3;
  return deckDown1;
};

/**
 * The same Deck, quoting a different price.
 *
 * Only the string is changed, because only the string is what a Trader was shown -- the
 * surface compares what they READ, not a value seven decimals down.
 */
const reprice = <T extends { cards: Array<{ premiumUsdc: { value: number; display: string } }> }>(deck: T): T => ({
  ...deck,
  cards: deck.cards.map((c) => ({ ...c, premiumUsdc: { ...c.premiumUsdc, display: "$2.15" } })),
});

/**
 * A Risk Budget generous enough that Maker Depth binds the confirmation's size cap
 * instead of the budget (issue #30, the "deep-budget" scenario). Every other scenario
 * in this stub leaves the $5 default budget as the tighter of the two -- this is the
 * one place the OTHER branch of "whichever binds first" is reachable.
 */
const deepBudget = (base: typeof session): typeof session => ({
  ...base,
  riskBudgetUsdc: 1000,
  remainingUsdc: 1000,
  figures: {
    ...base.figures,
    riskBudgetUsdc: { value: 1000, display: "$1,000.00" },
    remainingUsdc: { value: 1000, display: "$1,000.00" },
  },
});

/**
 * Money, formatted the way `apps/api/src/format.ts` formats it -- two decimal places,
 * a thousands separator. A duplicate on purpose: this is test infrastructure standing
 * in for what the REAL server derives on a resize (issue #30's `priceOrder`), and
 * `no-arithmetic.test.ts` does not reach `tests/`, so it may do this without being the
 * violation it would be inside `apps/web/components/` or `apps/web/lib/`.
 */
const money = (v: number): string => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What the real POST /rfq answers: always 501, always echoing back the request. This
 * mirrors `rfqRefusalMessage` in `apps/api/src/rfq.ts` -- test infrastructure standing
 * in for the server, not the browser originating a figure. ETH spot is fixed at
 * `deckDown1.spotUsd.value` ($2,445.49) across every fixture Deck.
 */
function rfqRefusal(body: { underlying: string; direction: "UP" | "DOWN"; strikeOffsetPct: number; horizonDays: number; sizeUsdc: number }) {
  const spot = deckDown1.spotUsd.value;
  const strike = money(spot * (1 + body.strikeOffsetPct / 100));
  const directionWord = body.direction === "DOWN" ? "below" : "above";
  return {
    error:
      "The sealed-bid RFQ backend is not built yet. Nothing was sent to a maker, nothing was signed, " +
      "and no USDC moved. " +
      `You asked for: ${body.underlying} ${directionWord} ${strike}, ${body.horizonDays} days, at most ${money(body.sizeUsdc)}.`,
  };
}

/**
 * What the real `/propose` does when a size changes: re-derive premium, Max Loss and
 * the contract count for the SAME Order at the new stake. The fixture book quotes a
 * fixed price per contract, so scaling the base answer by `sizeUsdc / baseSizeUsdc`
 * reproduces exactly what `priceOrder` would answer -- this is standing in for the
 * server, not the browser originating a figure.
 */
function resizeProposal(answer: any, sizeUsdc: number): any {
  if (!answer || answer.kind !== "PROPOSAL") return answer;
  const baseSize = answer.proposal.intent.sizeUsdc;
  if (sizeUsdc === baseSize) return answer;
  const scale = sizeUsdc / baseSize;
  const premium = Number((answer.proposal.premiumUsdc * scale).toFixed(6));
  const contractsValue = Number((answer.proposal.figures.contracts.value * scale).toFixed(6));
  return {
    ...answer,
    proposal: {
      ...answer.proposal,
      intent: { ...answer.proposal.intent, sizeUsdc },
      premiumUsdc: premium,
      maxLossUsdc: premium,
      figures: {
        ...answer.proposal.figures,
        premiumUsdc: { value: premium, display: money(premium) },
        maxLossUsdc: { value: premium, display: money(premium) },
        contracts: { value: contractsValue, display: contractsValue.toFixed(6) },
      },
    },
  };
}

/**
 * Install the stub.
 *
 * Returns the traffic log. Nothing is faked beyond the six routes the surface uses --
 * anything else 404s loudly rather than silently succeeding, so a route the frontend
 * starts calling shows up as a failure rather than as a hang.
 */
export async function stubApi(page: Page, scenario: Scenario = "normal"): Promise<Traffic> {
  await page.clock.install({ time: new Date(FIXTURE_NOW) });

  // A Practice Run flips the board, so the assertion "the board is never empty once a
  // Practice Run exists" is about the surface reacting, not about a canned response.
  let practised = false;
  let moved = false;
  // What /fill/prepare reserved and /fill/settle has not yet released or kept -- so a
  // journey that checks the Risk Budget after a failed fill sees the reservation
  // actually go away, rather than a number that never moved in the first place.
  let reservedUsdc = 0;
  // For the "settle-pending-once" scenario: the first settle attempt with a txHash
  // reports "not visible yet"; every one after succeeds.
  let settledOnce = false;

  const sessionSnapshot = () => {
    const spent = session.spentUsdc + reservedUsdc;
    const remaining = session.remainingUsdc - reservedUsdc;
    return {
      ...session,
      spentUsdc: spent,
      remainingUsdc: remaining,
      figures: {
        ...session.figures,
        spentUsdc: { value: spent, display: `$${spent.toFixed(2)}` },
        remainingUsdc: { value: remaining, display: `$${remaining.toFixed(2)}` },
      },
    };
  };

  // Issue #32's `hold`/`release` pair -- see `Traffic.hold` above for why this exists.
  // Keyed by pathname; only ONE outstanding hold per path at a time, which is all any
  // test here needs.
  const gates = new Map<string, Promise<void>>();
  const releasers = new Map<string, () => void>();

  const traffic: Traffic = {
    all: [],
    paths: () => traffic.all.map((r) => new URL(r.url()).pathname),
    bodies: [],
    moveTheQuote: () => {
      moved = true;
    },
    hold: (pathname: string) => {
      const promise = new Promise<void>((resolve) => releasers.set(pathname, resolve));
      gates.set(pathname, promise);
      return () => {
        releasers.get(pathname)?.();
        gates.delete(pathname);
        releasers.delete(pathname);
      };
    },
  };

  await page.route(`${API}/**`, async (route, request) => {
    traffic.all.push(request);
    const url = new URL(request.url());

    // Block here, before the response is decided, so the request is genuinely in
    // flight from the browser's point of view for as long as the test wants it to be.
    const gate = gates.get(url.pathname);
    if (gate) {
      gates.delete(url.pathname);
      await gate;
    }

    switch (url.pathname) {
      case "/deck": {
        if (scenario === "empty") return json(route, deckEmpty, traffic);
        if (scenario === "compressed") return json(route, deckCompressed, traffic);
        return json(route, moved ? reprice(deckFor(url)) : deckFor(url), traffic);
      }

      case "/markets":
        return json(route, markets, traffic);

      case "/depth":
        // The marked variant carries a held Position, a strike dimmed against the
        // default horizon, and a nonzero excluded count -- three things the real
        // fixture book does not happen to have, and `depth.spec.ts` asserts on.
        return json(route, scenario === "depth-marked" ? depthEthMarked : depthEth, traffic);

      case "/session":
        return json(route, scenario === "deep-budget" ? deepBudget(sessionSnapshot()) : sessionSnapshot(), traffic);

      case "/positions":
        return json(route, practised ? positionsAfterPractice : positionsEmpty, traffic);

      case "/propose": {
        // Gated the way the real route is: `/propose` costs a real Thetanuts pricing
        // call, so it demands the token even though it signs nothing.
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        if (scenario === "veto") return json(route, veto, traffic);
        if (scenario === "empty" || scenario === "no-order") return json(route, noOrder, traffic);
        if (scenario === "over-budget") return json(route, refusal.body, traffic, refusal.status);

        const body = request.postDataJSON() as { cardRef?: string; sizeUsdc?: number };
        const answer = body.cardRef ? fixtures.proposeByCard[body.cardRef] : proposeAgent;
        if (!answer) return route.fulfill({ status: 410, contentType: "application/json", body: '{"error":"gone"}' });
        // Issue #30: a resize is a fresh round trip against the same `cardRef` at a
        // different `sizeUsdc`. Standing in for what `priceOrder` would re-derive.
        return json(route, resizeProposal(answer, body.sizeUsdc ?? answer.proposal.intent.sizeUsdc), traffic);
      }

      case "/practice":
        practised = true;
        return json(route, practiceResult, traffic);

      /** Issue #31 -- always 501, the honest refusal, echoing back the request. */
      case "/rfq": {
        const body = request.postDataJSON() as {
          underlying: string;
          direction: "UP" | "DOWN";
          strikeOffsetPct: number;
          horizonDays: number;
          sizeUsdc: number;
        };
        return json(route, rfqRefusal(body), traffic, 501);
      }

      /*
       * Deliberately reachable, and deliberately gated.
       *
       * Reachable because the tests that matter assert `/fill/prepare` was never
       * REQUESTED, and a stub that made the request fail would let a bug where the
       * surface calls it and swallows the error pass unnoticed.
       *
       * Gated because the real route is: `requireToken` in `app.ts` answers 401 without
       * the bearer token. A stub that accepted anything would have let the surface ship
       * with no Authorization header at all -- which is exactly the bug that was here.
       */
      case "/auth/challenge": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        if (!accountAuthorised(request)) return json(route, { error: "Sign in to continue." }, traffic, 401);
        return json(route, authChallenge, traffic);
      }

      case "/auth/verify": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        if (!accountAuthorised(request)) return json(route, { error: "Sign in to continue." }, traffic, 401);
        return json(route, { walletAddress: FAKE_WALLET_ADDRESS }, traffic);
      }

      case "/fill/prepare": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        if (!accountAuthorised(request)) return json(route, { error: "Sign in to continue." }, traffic, 401);
        reservedUsdc = 2; // the stake -- released or kept once /fill/settle reports back
        return json(route, fillPrepare, traffic);
      }

      case "/account": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        if (!accountAuthorised(request)) return json(route, { error: "Sign in to continue." }, traffic, 401);
        return json(route, { settings: { riskBudgetUsdc: 5, defaultAsset: null, defaultDirection: null }, linkedWallet: null }, traffic);
      }

      case "/fill/settle": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { txHash } = request.postDataJSON() as { txHash?: string };
        // Simulates the settle call itself failing (a dropped connection, a transient
        // 502) AFTER the wallet has already broadcast and mined the fill -- the money
        // has moved regardless of whether this report of it reaches the backend.
        if (scenario === "settle-fails" && txHash) {
          return json(route, { error: "Could not update the Risk Budget." }, traffic, 502);
        }
        // Simulates the chain briefly not showing the transaction yet -- the second
        // attempt (and every one after) succeeds.
        if (scenario === "settle-pending-once" && txHash && !settledOnce) {
          settledOnce = true;
          return json(route, { error: "not visible yet" }, traffic, 425);
        }
        if (!txHash) reservedUsdc = 0; // released; a confirmed fill instead keeps it spent
        return json(route, { remainingUsdc: sessionSnapshot().remainingUsdc, confirmed: Boolean(txHash) }, traffic);
      }

      default:
        return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not stubbed"}' });
    }
  });

  return traffic;
}

/**
 * Anything the browser must never be handed OUTSIDE of `/fill/prepare`'s own response
 * (ADR-0011: that route alone returns real transaction calldata, encoding the maker
 * address of the order it names, because the Trader's own wallet has to see what it is
 * signing -- there is no way around that once signing happens client-side). Every
 * OTHER response is still held to the original, absolute guarantee.
 *
 * The fixtures were generated by the real API, so this is a genuine check on the
 * contract and not a check on the stub: a maker address or signature leaking into a
 * response other than /fill/prepare's would arrive here the same way it would in
 * production.
 */
export const FORBIDDEN = [
  // The fixture book's own markers.
  /0xMAKER/i,
  /0xSIGNATURE/i,
  // And the shapes a real one would take, so this keeps working against live data:
  // any 20-byte address, any 65-byte signature, and the field names that carry them.
  /0x[0-9a-f]{40}\b/i,
  /0x[0-9a-f]{130}/i,
  /"maker/i,
  /"nonce"/i,
  /"signature"/i,
  /orderId/i,
];

export const FAKE_WALLET_ADDRESS = "0x2222222222222222222222222222222222222222";

/**
 * A fake EIP-1193 provider, injected before the page's own scripts run -- the same
 * seam a real extension wallet occupies. Just capable enough to drive the app's
 * `wallet.ts` through connect + two sequential `sendTransaction` calls (approve, then
 * fill), which is everything the real-fill journeys need.
 *
 * `page.addInitScript` runs in the page's own context, so the function body below is
 * serialised and cannot close over anything from this module -- everything the fake
 * needs is passed in as its single argument.
 */
export async function installFakeWallet(
  page: Page,
  opts: { address?: string; fail?: boolean; preAuthorised?: boolean } = {}
): Promise<void> {
  const address = opts.address ?? FAKE_WALLET_ADDRESS;
  await page.addInitScript(
    (config: { address: string; fail: boolean; preAuthorised: boolean }) => {
      let authorised = config.preAuthorised;
      let txCount = 0;
      let lastHash = "";
      const BLOCK_HASH = "0x" + "11".repeat(32);
      const TO_ADDRESS = "0x0000000000000000000000000000000000000b00";
      (window as any).ethereum = {
        isMetaMask: true,
        request: async ({ method }: { method: string }) => {
          switch (method) {
            case "eth_accounts":
              return authorised ? [config.address] : [];
            case "eth_requestAccounts":
              authorised = true;
              return [config.address];
            case "eth_chainId":
              return "0x2105"; // 8453
            case "net_version":
              return "8453";
            case "personal_sign":
              return `0xFAKESIG${config.address.slice(2, 10)}`;
            // Everything below is machinery ethers' BrowserProvider calls while
            // populating a transaction (gas, nonce, fee data) before ever asking the
            // "wallet" to send it -- not behavior this suite is testing, so it gets
            // plausible fixed answers rather than a real RPC backend.
            case "eth_blockNumber":
              return "0x1";
            case "eth_gasPrice":
              return "0x3b9aca00";
            case "eth_estimateGas":
              return "0x5208";
            case "eth_getTransactionCount":
              return "0x0";
            case "eth_feeHistory":
              return {
                baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
                gasUsedRatio: [0.5],
                oldestBlock: "0x1",
                reward: [["0x3b9aca00"]],
              };
            case "eth_getBlockByNumber":
              return { number: "0x1", hash: BLOCK_HASH, baseFeePerGas: "0x3b9aca00" };
            case "eth_sendTransaction": {
              txCount += 1;
              lastHash = `0x${"f".repeat(63)}${txCount}`;
              return lastHash;
            }
            // ethers wraps the hash `eth_sendTransaction` returns into a full
            // TransactionResponse by looking it up here -- a real node has it the
            // instant it is submitted, so this always answers rather than 404ing, which
            // is what a real node does for the first few hundred ms after broadcast and
            // which sent ethers into a real (frozen-clock-proof, still endless) retry
            // loop here with no answer at all.
            case "eth_getTransactionByHash":
              return {
                hash: lastHash,
                blockHash: BLOCK_HASH,
                blockNumber: "0x1",
                transactionIndex: "0x0",
                from: config.address,
                to: TO_ADDRESS,
                gas: "0x5208",
                gasPrice: "0x3b9aca00",
                value: "0x0",
                nonce: "0x0",
                input: "0x12345678",
                type: "0x0",
                chainId: "0x2105",
                v: "0x1b",
                r: "0x" + "11".repeat(32),
                s: "0x" + "22".repeat(32),
              };
            case "eth_getTransactionReceipt":
              return {
                transactionHash: lastHash,
                transactionIndex: "0x0",
                blockHash: BLOCK_HASH,
                blockNumber: "0x1",
                from: config.address,
                to: TO_ADDRESS,
                contractAddress: null,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                effectiveGasPrice: "0x3b9aca00",
                logsBloom: "0x" + "00".repeat(256),
                logs: [],
                status: config.fail ? "0x0" : "0x1",
                type: "0x0",
              };
            default:
              throw new Error(`fake wallet: unhandled method ${method}`);
          }
        },
      };
    },
    { address, fail: opts.fail ?? false, preAuthorised: opts.preAuthorised ?? false }
  );
}
