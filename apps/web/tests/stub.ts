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
import session from "./fixtures/session.json" with { type: "json" };
import positionsEmpty from "./fixtures/positions-empty.json" with { type: "json" };
import positionsAfterPractice from "./fixtures/positions-after-practice.json" with { type: "json" };
import proposeAgent from "./fixtures/propose-agent.json" with { type: "json" };
import proposeByCard from "./fixtures/propose-by-card.json" with { type: "json" };
import practiceResult from "./fixtures/practice.json" with { type: "json" };
import fillPrepare from "./fixtures/fill-prepare.json" with { type: "json" };
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
  deckUp1,
  deckCompressed,
  session,
  proposeAgent,
  proposeByCard: proposeByCard as Record<string, any>,
  veto,
  practiceResult,
  positionsAfterPractice,
  fillPrepare,
};

/** Longest shot first, so index 0 is the leftmost Card in the row. */
export const cards = deckDown1.cards;

export type Scenario = "normal" | "veto" | "no-order" | "empty" | "compressed" | "over-budget";

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
}

const json = (route: Route, body: unknown, traffic: Traffic, status = 200) => {
  const text = JSON.stringify(body);
  traffic.bodies.push(text);
  return route.fulfill({ status, contentType: "application/json", body: text });
};

const authorised = (request: Request) => request.headers()["authorization"] === `Bearer ${TEST_API_TOKEN}`;

const deckFor = (url: URL) => {
  const direction = url.searchParams.get("direction");
  const days = url.searchParams.get("horizonDays");
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

  const traffic: Traffic = {
    all: [],
    paths: () => traffic.all.map((r) => new URL(r.url()).pathname),
    bodies: [],
    moveTheQuote: () => {
      moved = true;
    },
  };

  await page.route(`${API}/**`, async (route, request) => {
    traffic.all.push(request);
    const url = new URL(request.url());

    switch (url.pathname) {
      case "/deck": {
        if (scenario === "empty") return json(route, deckEmpty, traffic);
        if (scenario === "compressed") return json(route, deckCompressed, traffic);
        return json(route, moved ? reprice(deckFor(url)) : deckFor(url), traffic);
      }

      case "/session":
        return json(route, sessionSnapshot(), traffic);

      case "/positions":
        return json(route, practised ? positionsAfterPractice : positionsEmpty, traffic);

      case "/propose": {
        // Gated the way the real route is: `/propose` costs a real Thetanuts pricing
        // call, so it demands the token even though it signs nothing.
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        if (scenario === "veto") return json(route, veto, traffic);
        if (scenario === "empty" || scenario === "no-order") return json(route, noOrder, traffic);
        if (scenario === "over-budget") return json(route, refusal.body, traffic, refusal.status);

        const body = request.postDataJSON() as { cardRef?: string };
        const answer = body.cardRef ? fixtures.proposeByCard[body.cardRef] : proposeAgent;
        if (!answer) return route.fulfill({ status: 410, contentType: "application/json", body: '{"error":"gone"}' });
        return json(route, answer, traffic);
      }

      case "/practice":
        practised = true;
        return json(route, practiceResult, traffic);

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
      case "/fill/prepare": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        reservedUsdc = 2; // the stake -- released or kept once /fill/settle reports back
        return json(route, fillPrepare, traffic);
      }

      case "/fill/settle": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { succeeded } = request.postDataJSON() as { succeeded: boolean };
        if (!succeeded) reservedUsdc = 0; // released; a success instead keeps it spent
        return json(route, { remainingUsdc: sessionSnapshot().remainingUsdc }, traffic);
      }

      default:
        return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not stubbed"}' });
    }
  });

  return traffic;
}

/**
 * Anything the browser must never be handed OUTSIDE of `/fill/prepare`'s own response
 * (ADR-0009: that route alone returns real transaction calldata, encoding the maker
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
  opts: { address?: string; fail?: boolean } = {}
): Promise<void> {
  const address = opts.address ?? FAKE_WALLET_ADDRESS;
  await page.addInitScript(
    (config: { address: string; fail: boolean }) => {
      let authorised = false;
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
    { address, fail: opts.fail ?? false }
  );
}
