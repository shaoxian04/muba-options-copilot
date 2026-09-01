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
import session from "./fixtures/session.json" with { type: "json" };
import positionsEmpty from "./fixtures/positions-empty.json" with { type: "json" };
import positionsAfterPractice from "./fixtures/positions-after-practice.json" with { type: "json" };
import proposeAgent from "./fixtures/propose-agent.json" with { type: "json" };
import proposeByCard from "./fixtures/propose-by-card.json" with { type: "json" };
import practiceResult from "./fixtures/practice.json" with { type: "json" };
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

      case "/markets":
        return json(route, markets, traffic);

      case "/depth":
        return json(route, depthEth, traffic);

      case "/session":
        return json(route, session, traffic);

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
       * Reachable because the tests that matter assert `/fill` was never REQUESTED, and
       * a stub that made the request fail would let a bug where the surface calls it and
       * swallows the error pass unnoticed.
       *
       * Gated because the real route is: `requireToken` in `app.ts` answers 401 without
       * the bearer token. A stub that accepted anything would have let the surface ship
       * with no Authorization header at all -- which is exactly the bug that was here.
       */
      case "/fill": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(
          route,
          {
            txHash: "0xTESTTRANSACTION",
            optionAddress: "0xTESTOPTION",
            explorerUrl: "https://basescan.org/tx/0xTESTTRANSACTION",
          },
          traffic
        );
      }

      default:
        return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not stubbed"}' });
    }
  });

  return traffic;
}

/**
 * Anything the browser must never be handed.
 *
 * The fixtures were generated by the real API, so this is a genuine check on the
 * contract and not a check on the stub: a maker address or signature leaking into a
 * response would arrive here the same way it would arrive in production.
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
