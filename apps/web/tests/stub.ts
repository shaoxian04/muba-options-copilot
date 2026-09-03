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
  fillPrepare,
  authChallenge,
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
  | "settle-fails"
  | "settle-pending-once"
  | "depth-marked"
  | "deep-budget"
  /** No maker ever answers the RFQ: the offer window closes empty. */
  | "rfq-unanswered";

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
 * The sealed-bid auction, faked (ADR-0015).
 *
 * Test infrastructure standing in for the server, exactly as `resized` below stands in
 * for `priceOrder` -- so it may format money, which `no-arithmetic.test.ts` would forbid
 * anywhere under `components/` or `lib/`. What it must NOT do is invent a shape the real
 * routes do not answer with, so each field below mirrors `packages/shared/src/rfq.ts`.
 *
 * The one liberty it takes is time. A real offer window runs for ten minutes; here a
 * maker answers on the SECOND status poll, so a test can watch the wait and then watch it
 * end without holding a browser open for ten minutes. `rfq-unanswered` is the other
 * branch: nobody ever answers and the window closes empty.
 *
 * The maker's address, its signature and its nonce appear nowhere in any of these bodies
 * -- the leak check in `FORBIDDEN` runs over every one of them, and a sealed bid whose
 * bidder is published is not sealed.
 */
const FIXTURE_EXPIRY = { value: FIXTURE_NOW + 14 * 86_400_000, display: "29 Jan, 08:00 UTC" };
const FIXTURE_OFFERS_CLOSE = { value: FIXTURE_NOW + 10 * 60_000, display: "15 Jan, 12:10 UTC" };
/** The premium a maker bids. Under every fixture Reserve Price, so it is always acceptable. */
const FIXTURE_PREMIUM = { value: 1.25, display: "$1.25" };

interface StubRfq {
  requestId: string;
  kind: "TRADER" | "COVER";
  ask: Record<string, unknown>;
  phase: "AWAITING_SIGNATURE" | "OPEN" | "OFFERED" | "NO_OFFERS" | "SETTLED" | "CANCELLED";
  polls: number;
  reserveUsdc: number;
}

/** The Ask a TRADER request would be built into, off the fixture spot. */
function traderAsk(body: { underlying: string; direction: "UP" | "DOWN"; strikeOffsetPct: number; sizeUsdc: number }) {
  const spot = deckDown1.spotUsd.value;
  const strike = spot * (1 + body.strikeOffsetPct / 100);
  const optionType = body.direction === "DOWN" ? "PUT" : "CALL";
  const what = optionType === "PUT" ? "puts" : "calls";
  return {
    underlying: body.underlying,
    optionType,
    strike: { value: strike, display: money(strike) },
    contracts: { value: 1, display: "1.000000" },
    reservePriceUsdc: { value: body.sizeUsdc, display: money(body.sizeUsdc) },
    expiry: FIXTURE_EXPIRY,
    offersCloseAt: FIXTURE_OFFERS_CLOSE,
    coverage: null,
    sentence:
      `1.000000 ${body.underlying} ${what} struck at ${money(strike)}, ending ${FIXTURE_EXPIRY.display}, ` +
      `for at most ${money(body.sizeUsdc)} in total.`,
  };
}

/** The Ask a COVER request would be built into, off that Loan's own fixture quote. */
function coverAsk(quote: (typeof coverHealthy)["quote"]) {
  return {
    underlying: quote.underlying,
    optionType: "PUT",
    strike: quote.cover.targetStrike,
    contracts: quote.cover.requiredContracts,
    reservePriceUsdc: quote.cover.premiumCapUsdc,
    expiry: quote.cover.expiry,
    offersCloseAt: FIXTURE_OFFERS_CLOSE,
    coverage: { value: 1, display: "100%" },
    sentence:
      `${quote.cover.requiredContracts.display} ${quote.underlying} puts struck at ` +
      `${quote.cover.targetStrike.display}, ending ${quote.cover.expiry.display}, for at most ` +
      `${quote.cover.premiumCapUsdc.display} in total. That is 100% of what this loan needs.`,
  };
}

/** The server's own sentence for each phase, mirroring `phraseFor` in `apps/api/src/rfq.ts`. */
function rfqSentence(phase: StubRfq["phase"]): string {
  switch (phase) {
    case "AWAITING_SIGNATURE":
      return "Nothing has been sent yet. Your wallet has not signed anything and no USDC has moved.";
    case "OPEN":
      return `The request is live. Market makers can answer until ${FIXTURE_OFFERS_CLOSE.display}. Nothing is owed unless you accept an answer.`;
    case "OFFERED":
      return "A market maker has answered. Nothing is paid until you confirm, and the price you are shown is the price you would pay -- not an estimate.";
    case "NO_OFFERS":
      return `Offers closed ${FIXTURE_OFFERS_CLOSE.display} and nobody answered at or under your Reserve Price. No USDC moved. You can withdraw the request and ask again.`;
    case "SETTLED":
      return `Bought. It ends ${FIXTURE_EXPIRY.display}, and nothing renews on its own -- renewing without you would mean signing without you.`;
    case "CANCELLED":
      return "The request was withdrawn. Nothing was bought and no USDC moved.";
  }
}

function rfqStatusBody(r: StubRfq) {
  const offers = r.phase === "OFFERED" || r.phase === "SETTLED" ? 1 : 0;
  return {
    requestId: r.requestId,
    kind: r.kind,
    phase: r.phase,
    ask: r.ask,
    quotationId: r.phase === "AWAITING_SIGNATURE" ? null : "7",
    offers: { value: offers, display: String(offers) },
    premiumUsdc: r.phase === "OFFERED" || r.phase === "SETTLED" ? FIXTURE_PREMIUM : null,
    optionAddress: r.phase === "SETTLED" ? "0x00000000000000000000000000000000000000aa" : null,
    sentence: rfqSentence(r.phase),
  };
}

/**
 * The COVER door's answer to `POST /rfq`.
 *
 * A coverable Loan gets a prepared request; an uncoverable one gets that Loan's own
 * refusal as a normal 200 -- the same `CoverRefusal` shape `GET /cover/quote` answers
 * with, because being told "this Loan holds two assets" is an answer, not a failure.
 */
function coverRfqAnswer(address: string): { status: 200; body: unknown; ask?: Record<string, unknown> } {
  const known = COVER_RESPONSES[address] as { refusal?: unknown; quote?: (typeof coverHealthy)["quote"] } | undefined;
  if (known && known.refusal) {
    return { status: 200, body: { status: "REFUSED", refusal: known.refusal } };
  }
  return { status: 200, body: null, ask: coverAsk(known?.quote ?? coverHealthy.quote) };
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

  /**
   * Sealed-bid requests this run has opened, keyed by id -- the stub's own tiny version
   * of the server-side store in `sessions.ts`. Per-run, so one test's request cannot be
   * seen by the next.
   */
  const rfqs = new Map<string, StubRfq>();
  let rfqSeq = 0;

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

    /**
     * `GET /rfq/:requestId` -- the wait.
     *
     * Handled before the switch because the path carries an id, and the switch matches
     * whole pathnames. Every OTHER `/rfq/...` route has a fixed path and falls through to
     * its own case below.
     *
     * A maker answers on the SECOND poll. That is the stub compressing ten real minutes
     * into two ticks so a test can watch the wait and then watch it end -- the phases
     * themselves, and the order they come in, are exactly what the server produces.
     */
    if (request.method() === "GET" && /^\/rfq\/[^/]+$/.test(url.pathname)) {
      if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
      const requestId = decodeURIComponent(url.pathname.slice("/rfq/".length));
      const r = rfqs.get(requestId);
      if (!r) return json(route, { error: "That request is no longer open." }, traffic, 410);

      if (r.phase === "OPEN") {
        r.polls += 1;
        if (scenario === "rfq-unanswered") {
          // The window closes empty. Not a failure -- a market condition, and the one
          // outcome a demo is most likely to actually hit.
          if (r.polls >= 2) r.phase = "NO_OFFERS";
        } else if (r.polls >= 2) {
          r.phase = "OFFERED";
        }
      }
      return json(route, rfqStatusBody(r), traffic);
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
       * The RFQ money path (ADR-0015). Both doors, and all seven routes.
       *
       * `POST /rfq` builds the request and hands back the ONE transaction a wallet must
       * send; nothing is bought and no premium exists yet. `/rfq/confirm` is where the
       * chain reports whether it opened. `GET /rfq/:id` is the wait. The two `settle`
       * routes are the second signature -- the first moment a real price is shown at all.
       *
       * The Reserve Price is held against the Risk Budget from the moment `/rfq` answers,
       * the same way `/fill/prepare` reserves a Max Loss, so a journey that watches the
       * budget sees it actually move.
       */
      case "/rfq": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const body = request.postDataJSON() as
          | { kind: "TRADER"; underlying: string; direction: "UP" | "DOWN"; strikeOffsetPct: number; horizonDays: number; sizeUsdc: number; walletAddress: string }
          | { kind: "COVER"; address: string };

        let ask: Record<string, unknown>;
        if (body.kind === "COVER") {
          const answer = coverRfqAnswer(body.address);
          if (!answer.ask) return json(route, answer.body, traffic, answer.status);
          ask = answer.ask;
        } else {
          ask = traderAsk(body);
        }

        const requestId = `rfq-${++rfqSeq}`;
        const reserveUsdc = (ask.reservePriceUsdc as { value: number }).value;
        rfqs.set(requestId, { requestId, kind: body.kind, ask, phase: "AWAITING_SIGNATURE", polls: 0, reserveUsdc });
        reservedUsdc += reserveUsdc;

        return json(
          route,
          {
            requestId,
            kind: body.kind,
            ask,
            // Real hex: `lib/wallet.ts` feeds this to a genuine ethers `sendTransaction`,
            // which validates `data` as actual bytes.
            requestTx: { to: "0x8118dad971debffb49b9280047659174128a8b94", data: "0xa1b2c3d4" },
            explorerTxUrlBase: "https://basescan.org/tx/",
            remainingUsdc: session.remainingUsdc - reservedUsdc,
          },
          traffic
        );
      }

      case "/rfq/confirm": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { requestId, txHash } = request.postDataJSON() as { requestId: string; txHash?: string };
        const r = rfqs.get(requestId);
        if (!r) return json(route, { error: "That request is no longer open." }, traffic, 410);

        // No hash means the wallet declined: nothing was ever sent, so the reservation is
        // released -- exactly what the real route does.
        if (!txHash) {
          reservedUsdc -= r.reserveUsdc;
          rfqs.delete(requestId);
          return json(route, { opened: false, remainingUsdc: session.remainingUsdc - reservedUsdc }, traffic);
        }

        r.phase = "OPEN";
        return json(
          route,
          { opened: true, remainingUsdc: session.remainingUsdc - reservedUsdc, status: rfqStatusBody(r) },
          traffic
        );
      }

      case "/rfq/settle/prepare": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { requestId } = request.postDataJSON() as { requestId: string };
        const r = rfqs.get(requestId);
        if (!r) return json(route, { error: "That request is no longer open." }, traffic, 410);
        if (r.phase !== "OFFERED")
          return json(
            route,
            { error: "No maker has answered at or under your Reserve Price, so there is no price to accept. Nothing was signed and no USDC moved." },
            traffic,
            409
          );

        return json(
          route,
          {
            requestId,
            approveTx: { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", data: "0x095ea7b3" },
            settleTx: { to: "0x8118dad971debffb49b9280047659174128a8b94", data: "0xdeadbeef" },
            premiumUsdc: FIXTURE_PREMIUM,
            ask: r.ask,
            explorerTxUrlBase: "https://basescan.org/tx/",
            sentence: `You will pay ${FIXTURE_PREMIUM.display}, and that is the whole of what this can ever cost you. It ends ${FIXTURE_EXPIRY.display}. Nothing renews on its own.`,
          },
          traffic
        );
      }

      case "/rfq/settle": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { requestId, txHash } = request.postDataJSON() as { requestId: string; txHash?: string };
        const r = rfqs.get(requestId);
        if (!r) return json(route, { error: "That request is no longer open." }, traffic, 410);

        // The wallet declined. The request is still live on-chain and still holding its
        // Reserve Price, so nothing is released.
        if (!txHash)
          return json(
            route,
            { settled: false, remainingUsdc: session.remainingUsdc - reservedUsdc, status: rfqStatusBody(r) },
            traffic
          );

        r.phase = "SETTLED";
        // The ceiling gives way to the real premium: what was held was always the most it
        // could cost, and the difference comes back.
        reservedUsdc -= r.reserveUsdc - FIXTURE_PREMIUM.value;
        return json(
          route,
          { settled: true, remainingUsdc: session.remainingUsdc - reservedUsdc, status: rfqStatusBody(r) },
          traffic
        );
      }

      case "/rfq/cancel/prepare": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { requestId } = request.postDataJSON() as { requestId: string };
        const r = rfqs.get(requestId);
        if (!r) return json(route, { error: "That request is no longer open." }, traffic, 410);
        return json(
          route,
          {
            requestId,
            cancelTx: { to: "0x8118dad971debffb49b9280047659174128a8b94", data: "0xfeedface" },
            explorerTxUrlBase: "https://basescan.org/tx/",
            sentence: "Withdrawing takes back your commitment to pay. Nothing has been bought and no USDC has moved.",
          },
          traffic
        );
      }

      case "/rfq/cancel": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        const { requestId, txHash } = request.postDataJSON() as { requestId: string; txHash?: string };
        const r = rfqs.get(requestId);
        if (!r) return json(route, { error: "That request is no longer open." }, traffic, 410);
        if (!txHash) return json(route, { cancelled: false, remainingUsdc: session.remainingUsdc - reservedUsdc }, traffic);

        r.phase = "CANCELLED";
        reservedUsdc -= r.reserveUsdc;
        return json(route, { cancelled: true, remainingUsdc: session.remainingUsdc - reservedUsdc }, traffic);
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
        return json(route, authChallenge, traffic);
      }

      case "/auth/verify": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        return json(route, { walletAddress: FAKE_WALLET_ADDRESS }, traffic);
      }

      case "/fill/prepare": {
        if (!authorised(request)) return json(route, { error: "Unauthorized" }, traffic, 401);
        reservedUsdc = 2; // the stake -- released or kept once /fill/settle reports back
        return json(route, fillPrepare, traffic);
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

/**
 * How often the surface re-reads an open RFQ. Mirrors `RFQ_POLL_MS` in `lib/surface.ts`.
 *
 * Duplicated here rather than imported because `lib/surface.ts` is a client React module
 * and pulling it into a Playwright spec drags React in with it. Kept honest by
 * `advanceOffers` below, which is the only thing that reads it: if the two ever disagree,
 * every RFQ journey stops seeing an offer arrive and says so loudly.
 */
export const RFQ_POLL_MS = 6_000;

/**
 * Step the frozen clock until the surface has polled an open request far enough for
 * `ready` to hold -- normally, until the stub's maker has answered.
 *
 * `page.clock.install` freezes time, so a `setInterval` never fires on its own and the
 * clock has to be driven. Two things make that fiddlier than one `runFor`:
 *
 *   - the polling effect RE-ARMS itself whenever the status changes, so a single large
 *     jump steps straight over the newly-armed timer rather than firing it;
 *   - each tick starts a real fetch, and how long that takes is real time, not clock
 *     time. A fixed sleep between steps is a guess that is right on an idle machine and
 *     wrong under eight parallel workers.
 *
 * So: step, check, repeat. Stopping as soon as `ready` holds keeps the fast case fast,
 * and the generous tick budget is what makes the slow case pass rather than flake.
 */
export async function advanceOffers(page: Page, ready?: () => Promise<boolean>, ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (ready && (await ready().catch(() => false))) return;
    await page.clock.runFor(RFQ_POLL_MS + 500);
    await page.waitForTimeout(100);
  }
}

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
