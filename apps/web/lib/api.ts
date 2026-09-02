/**
 * The only way this app talks to anything.
 *
 * ADR-0004: the frontend is UI. It holds no key, no SDK and no protocol knowledge -- it
 * asks the backend, and the backend answers with strings already formatted. Every
 * function here returns data straight from the wire; none of them derives a figure, and
 * none of them may start to.
 *
 * The session header is what makes a `cardRef` resolvable: refs are minted per session,
 * so the Deck a Trader is looking at and the Card they pick have to arrive under the
 * same id.
 */
import type {
  Card, ConversationTurn, CoinAskResult, Deck, DepthView, ExpiryOption, Figure, Holding,
  MarketOverview, MarketRow, ProposeResult, RfqTenorDays, UnderlyingSymbol,
  CoverQuote, CoverQuoteResult, CoverRefusal,
} from "@copilot/shared";

export type {
  Card, ConversationTurn, CoinAskResult, Deck, DepthView, ExpiryOption, Figure, Holding,
  MarketOverview, MarketRow, ProposeResult, RfqTenorDays, UnderlyingSymbol,
  CoverQuote, CoverQuoteResult, CoverRefusal,
};

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:3001";

/**
 * The bearer token `/fill` and `/propose` require whenever one is configured.
 *
 * `/propose` is gated too, not just `/fill`: it signs nothing, but every call is a real
 * Thetanuts pricing request billed to whoever runs the backend.
 *
 * `.env.example` states the contract plainly -- "The frontend sends it as
 * `Authorization: Bearer ...`" -- and without this Confirm answers 401 for anyone who
 * followed the documented security posture.
 *
 * It is inlined into the bundle, which is the honest cost of a browser holding it. That
 * is acceptable for what the token actually defends against: a page on another origin
 * POSTing to loopback. Such a page cannot read this bundle (the CORS allowlist in
 * `app.ts` sees to that), so it cannot learn the token. It is NOT a secret from the
 * person sitting at the browser, and it was never meant to be -- the wallet is theirs.
 */
const API_TOKEN = process.env.NEXT_PUBLIC_COPILOT_API_TOKEN ?? "";

/** Sent on the gated routes, and only when a token is actually configured. */
const authHeaders = (): Record<string, string> =>
  API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {};

/** The Risk Budget, with the strings the commit bar reads. */
export interface SessionState {
  riskBudgetUsdc: number;
  spentUsdc: number;
  remainingUsdc: number;
  figures: { riskBudgetUsdc: Figure; spentUsdc: Figure; remainingUsdc: Figure };
}

export interface Board {
  address: string | null;
  spotUsd: Figure | null;
  holdings: Holding[];
}

export interface FillReceipt {
  txHash: string;
  optionAddress: string;
  explorerUrl: string;
}

/**
 * A refusal the Trader is meant to read.
 *
 * The Risk Budget saying no is not a bug and must not be rendered as one -- it is the
 * ceiling they set when calm, working. The server writes the sentence; the surface
 * shows it verbatim rather than composing its own, because composing one would mean
 * putting the numbers back in React.
 */
export class ApiRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiRefusal";
  }
}

const SESSION_KEY = "copilot-session-id";

/**
 * A stable id for this tab.
 *
 * Stable so a Card stays pickable across a Deck poll, and per-tab so two windows do not
 * share a Risk Budget. It is not a credential: `/fill` is loopback-only and token-gated,
 * which is the only reason an unauthenticated session header is acceptable at all.
 */
export function sessionId(): string {
  if (typeof window === "undefined") return "server";
  let id = window.sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiRefusal(res.status, body?.error ?? `The server answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

export const getDeck = (q: {
  asset: UnderlyingSymbol;
  direction: "UP" | "DOWN";
  horizonDays: number;
  sizeUsdc: number;
  /** Lets `lib/surface.ts` cancel a read a Trader has since navigated away from. */
  signal?: AbortSignal;
}): Promise<Deck> =>
  call<Deck>(`/deck?asset=${q.asset}&direction=${q.direction}&horizonDays=${q.horizonDays}&sizeUsdc=${q.sizeUsdc}`, {
    signal: q.signal,
  });

/**
 * Every market that is quoting. One request, not six -- the rail is the first thing on
 * the surface and six round trips would make the app feel broken before a Trader acts.
 */
export const getMarkets = (): Promise<MarketOverview> => call<MarketOverview>("/markets");

/**
 * Where makers will actually trade on one Underlying -- the Maker Depth chart's data.
 *
 * Deliberately narrower than `getDeck`: no `direction`, because the chart is filtered
 * by neither direction nor expiry (issue #28). `horizonDays` is optional and governs
 * one statistic -- the Implied Move -- so it is left off the query when the caller has
 * none to name rather than defaulted to one that answers a question nobody asked.
 */
export const getDepth = (q: {
  asset: UnderlyingSymbol;
  horizonDays?: number;
  /** Lets `lib/surface.ts` cancel a read a Trader has since navigated away from. */
  signal?: AbortSignal;
}): Promise<DepthView> =>
  call<DepthView>(
    `/depth?asset=${q.asset}${q.horizonDays === undefined ? "" : `&horizonDays=${q.horizonDays}`}`,
    { signal: q.signal }
  );

export const getSession = (): Promise<SessionState> => call<SessionState>("/session");

export const getBoard = (): Promise<Board> => call<Board>("/positions");

/**
 * Ask for a trade.
 *
 * With a `cardRef` this is the Trader overruling the agent; without one the Trade Agent
 * picks. Either way the server re-fetches the Order and re-derives every number, so the
 * response is the only thing the surface may render -- never the Card object already
 * sitting in the browser.
 */
export const propose = (body: {
  underlying: UnderlyingSymbol;
  direction: "UP" | "DOWN";
  horizonDays: number;
  sizeUsdc: number;
  cardRef?: string;
}): Promise<ProposeResult> =>
  call<ProposeResult>("/propose", {
    method: "POST",
    // No `underlying: "ETH"` default here any more. It used to be spread in ahead of the
    // caller's fields, which meant the surface could not have asked for anything else
    // even once the book opened -- an ETH-only assumption hidden in a spread.
    body: JSON.stringify(body),
    headers: authHeaders(),
  });

/** Spends real USDC. Only ever called from the Trader's own press on Confirm. */
export const fill = (proposalId: string): Promise<FillReceipt> =>
  call<FillReceipt>("/fill", {
    method: "POST",
    body: JSON.stringify({ proposalId }),
    headers: authHeaders(),
  });

/**
 * Ask the Insights surface a free-text question about any coin(s) -- price, news, a
 * forward-looking view, risk/benefit, or a comparison across several. Read-only: signs
 * nothing and cannot reach `/fill`. One entry per coin the question named; a coin that
 * failed carries only an `error`, and one coin failing never blocks the others.
 *
 * `history` carries the last few successful exchanges so a follow-up ("what about SOL
 * too?") can be resolved against what was actually asked before.
 */
export const askForecast = (
  question: string,
  history: ConversationTurn[] = []
): Promise<Record<string, CoinAskResult>> =>
  call<Record<string, CoinAskResult>>("/forecast/ask", {
    method: "POST",
    body: JSON.stringify({ question, history }),
    headers: authHeaders(),
  });

/**
 * Opens a simulated Position. Spends nothing and signs nothing.
 *
 * A separate route, not a flag -- see `apps/api/src/practice.ts`. The surface keeps that
 * separation visible: there is no shared "submit" that decides which endpoint to hit
 * from a boolean, because that boolean is exactly the thing that fails open.
 */
export const practice = (proposalId: string): Promise<{ holding: Holding }> =>
  call<{ holding: Holding }>("/practice", { method: "POST", body: JSON.stringify({ proposalId }) });

/**
 * Name a strike the book does not offer (issue #31).
 *
 * This always throws `ApiRefusal(501, ...)` -- the sealed-bid RFQ backend is out of
 * scope, and this route exists to refuse honestly rather than pretend a maker is
 * pricing anything. `strikeOffsetPct` is the slider's own raw number, never resolved
 * to a dollar strike in this file or anywhere else in the browser: only the server,
 * which alone holds live spot, may turn it into one, and it does that only inside the
 * refusal's own echoed sentence.
 *
 * `kind: "TRADER"` is injected here so the call site in `surface.ts` needs no change --
 * the union discriminant is an implementation detail of the wire shape, not something
 * a caller thinking about a trade needs to name.
 */
export const requestRfq = (body: {
  underlying: UnderlyingSymbol;
  direction: "UP" | "DOWN";
  strikeOffsetPct: number;
  horizonDays: RfqTenorDays;
  sizeUsdc: number;
}): Promise<never> =>
  call<never>("/rfq", { method: "POST", body: JSON.stringify({ kind: "TRADER", ...body }), headers: authHeaders() });

/**
 * The Cover door's RFQ request (issue #43): a selector, not figures. The server
 * re-reads the Loan off Aave and re-derives strike, size and cap itself -- a stale
 * or tampered browser cannot change what is actually requested.
 *
 * A coverable Loan throws `ApiRefusal(501, ...)` (the sealed-bid backend is not built).
 * An uncoverable Loan returns `{ status: "REFUSED", refusal }` as a normal 200 -- the
 * same shape `getCoverQuote` uses, so a later surface can treat both identically.
 * (The return type below says so -- `Promise<never>` would claim this call can only
 * ever throw, which is exactly the half of the contract the REFUSED path is for.)
 */
export const requestCoverRfq = (body: {
  address: string;
}): Promise<{ status: "REFUSED"; refusal: CoverRefusal }> =>
  call<{ status: "REFUSED"; refusal: CoverRefusal }>("/rfq", {
    method: "POST",
    body: JSON.stringify({ kind: "COVER", ...body }),
    headers: authHeaders(),
  });

/**
 * A Borrower's Loan, and the Cover it would need. Read-only: it requests nothing from a
 * maker and signs nothing.
 *
 * A REFUSED result arrives as a normal 200 and is returned, not thrown -- being told
 * "this Loan holds two assets and here is why that matters" is an answer, not a failure,
 * and throwing it would push a true sentence into an error boundary.
 */
export const getCoverQuote = (q: {
  address: string;
  signal?: AbortSignal;
}): Promise<CoverQuoteResult> =>
  call<CoverQuoteResult>(`/cover/quote?address=${encodeURIComponent(q.address)}`, { signal: q.signal });
