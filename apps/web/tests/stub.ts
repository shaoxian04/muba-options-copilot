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
import veto from "./fixtures/veto.json" with { type: "json" };
import noOrder from "./fixtures/no-order.json" with { type: "json" };
import refusal from "./fixtures/refusal.json" with { type: "json" };
import coverHealthy from "./fixtures/cover-healthy.json" with { type: "json" };
import coverTight from "./fixtures/cover-tight.json" with { type: "json" };
import coverCbbtc from "./fixtures/cover-cbbtc.json" with { type: "json" };
import coverFarStrike from "./fixtures/cover-far-strike.json" with { type: "json" };
import coverRefusedMultiCollateral from "./fixtures/cover-refused-multi-collateral.json" with { type: "json" };
import coverRefusedNoDebt from "./fixtures/cover-refused-no-debt.json" with { type: "json" };
import coverRefusedAlreadyLiquidatable from "./fixtures/cover-refused-already-liquidatable.json" with { type: "json" };
import coverRefusedUnsupportedCollateral from "./fixtures/cover-refused-unsupported-collateral.json" with { type: "json" };
import coverRefusedNoCollateral from "./fixtures/cover-refused-no-collateral.json" with { type: "json" };

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
  depthEth,
  depthEthMarked,
};

/**
 * The wallet addresses that route to a specific Cover fixture, issue #44's fixture-backed
 * replacement for the earlier hand-written placeholder. `GET /cover/quote` is keyed by
 * `address` alone, so a Playwright test picks a scenario by which address it types into
 * the form -- named here so a spec never has to retype a raw hex string to pick one.
 *
 * The four QUOTE addresses are read straight off their own fixture (each was generated
 * against a distinct address, so there is nothing to invent); the five REFUSED fixtures
 * carry no address in their wire shape at all (a `CoverRefusal` is just `{ code, message }`),
 * so those five are given arbitrary, memorable addresses here -- except `noCollateral`,
 * whose fixture message happens to name a real address, reused rather than duplicated.
 */
export const COVER_ADDRESSES = {
  healthy: coverHealthy.quote.address,
  tight: coverTight.quote.address,
  cbbtc: coverCbbtc.quote.address,
  farStrike: coverFarStrike.quote.address,
  multiCollateral: "0x111111111111111111111111111111111111111a",
  noDebt: "0x222222222222222222222222222222222222222b",
  alreadyLiquidatable: "0x333333333333333333333333333333333333333c",
  unsupportedCollateral: "0x444444444444444444444444444444444444444d",
  noCollateral: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
} as const;

/**
 * The nine Cover response bodies, keyed by the address above that selects each one.
 * Anything else -- including `shell.spec.ts`'s own arbitrary address -- falls back to
 * the healthy QUOTE, which is what that spec needs: a renderable quote with a real
 * disclaimer to scroll to.
 */
const COVER_RESPONSES: Record<string, unknown> = {
  [COVER_ADDRESSES.healthy]: coverHealthy,
  [COVER_ADDRESSES.tight]: coverTight,
  [COVER_ADDRESSES.cbbtc]: coverCbbtc,
  [COVER_ADDRESSES.farStrike]: coverFarStrike,
  [COVER_ADDRESSES.multiCollateral]: coverRefusedMultiCollateral,
  [COVER_ADDRESSES.noDebt]: coverRefusedNoDebt,
  [COVER_ADDRESSES.alreadyLiquidatable]: coverRefusedAlreadyLiquidatable,
  [COVER_ADDRESSES.unsupportedCollateral]: coverRefusedUnsupportedCollateral,
  [COVER_ADDRESSES.noCollateral]: coverRefusedNoCollateral,
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
 * What the real POST /rfq answers for the COVER member (issue #43/#46), keyed by the
 * same addresses `GET /cover/quote` uses. A coverable Loan gets the honest 501,
 * echoing figures re-derived from that Loan's OWN fixture -- never from the request
 * body, which for a COVER request carries only an address to begin with. An
 * uncoverable Loan gets a normal 200 carrying that Loan's own refusal, the same
 * `CoverRefusal` shape `GET /cover/quote` already answers with.
 */
function coverRfqAnswer(address: string): { status: 200 | 501; body: unknown } {
  const known = COVER_RESPONSES[address] as { refusal?: unknown; quote?: (typeof coverHealthy)["quote"] } | undefined;
  if (known && known.refusal) {
    return { status: 200, body: { status: "REFUSED", refusal: known.refusal } };
  }
  const quote = known?.quote ?? coverHealthy.quote;
  return {
    status: 501,
    body: {
      error:
        "The sealed-bid RFQ backend is not built yet. Nothing was sent to a maker, nothing was signed, " +
        "and no USDC moved. " +
        `You asked to cover this Loan: a ${quote.underlying} put struck at ${quote.cover.targetStrike.display}, ` +
        `${quote.cover.tenorDays.value} days, at most ${quote.cover.premiumCapUsdc.display}.`,
    },
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
        return json(route, scenario === "deep-budget" ? deepBudget(session) : session, traffic);

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

      /*
       * Issue #44: a real Cover fixture, keyed by the address the form submitted.
       *
       * Every one of these nine bodies came out of the shipped `GET /cover/quote` --
       * real `liquidation.ts` arithmetic, real `format.ts` strings -- with only the
       * chain read stubbed (see `apps/api/src/test/stub-loan.ts`). An address this
       * suite does not specifically recognise falls back to the healthy quote, which
       * is what `shell.spec.ts` needs: a renderable QUOTE with a real disclaimer to
       * scroll to.
       */
      case "/cover/quote": {
        const requested = url.searchParams.get("address") ?? "";
        const body = COVER_RESPONSES[requested] ?? coverHealthy;
        return json(route, body, traffic);
      }

      /**
       * Issue #31/#43/#46 -- the RFQ union. TRADER always 501, echoing the request.
       * COVER is a selector (an address, and nothing else): a coverable Loan still
       * gets the honest 501, but an uncoverable one gets that Loan's own refusal as a
       * normal 200 -- see `coverRfqAnswer` above.
       */
      case "/rfq": {
        const body = request.postDataJSON() as
          | { kind: "TRADER"; underlying: string; direction: "UP" | "DOWN"; strikeOffsetPct: number; horizonDays: number; sizeUsdc: number }
          | { kind: "COVER"; address: string };

        if (body.kind === "COVER") {
          const answer = coverRfqAnswer(body.address);
          return json(route, answer.body, traffic, answer.status);
        }
        return json(route, rfqRefusal(body), traffic, 501);
      }

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
