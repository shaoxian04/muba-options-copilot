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
  AccountActivityResponse, AccountResponse, AccountSettingsRequest,
  Card, ConversationTurn, CoinAskResult, CoverQuote, CoverQuoteResult, CoverRefusal,
  DecisionRequest, Deck, DepthView, ExpiryOption, Figure, Holding, HistoryItem, HistoryResponse,
  MarketOverview, MarketRow, PreparedFill, ProposeResult, RfqTenorDays, RiskProfileName,
  RiskProfileResponse, SuggestionResponse, UnderlyingSymbol, TradeIntent,
  PreparedRfq, PreparedRfqCancel, PreparedRfqSettle, RfqAsk, RfqPhase, RfqStatus,
} from "@copilot/shared";
import { supabase } from "./supabaseClient";

export type {
  AccountActivityResponse, AccountResponse, AccountSettingsRequest,
  Card, ConversationTurn, CoinAskResult, CoverQuote, CoverQuoteResult, CoverRefusal,
  DecisionRequest, Deck, DepthView, ExpiryOption, Figure, Holding, HistoryItem, HistoryResponse,
  MarketOverview, MarketRow, PreparedFill, ProposeResult, RfqTenorDays, RiskProfileName,
  RiskProfileResponse, SuggestionResponse, UnderlyingSymbol,
  PreparedRfq, PreparedRfqCancel, PreparedRfqSettle, RfqAsk, RfqPhase, RfqStatus,
};

export function getApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE;
  if (configured && !configured.includes("127.0.0.1") && !configured.includes("localhost")) {
    return configured;
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname || "localhost";
    return `${window.location.protocol}//${host}:3001`;
  }
  return configured ?? "http://127.0.0.1:3001";
}

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
 * It is inlined into the bundle, which is the honest cost of a browser holding it. It IS
 * a real defense against CSRF -- a page on another origin cannot read this bundle (the
 * CORS allowlist in `app.ts` sees to that), so it cannot learn the token to attach to a
 * forged cross-origin request. It is NOT a secret from the person sitting at the browser
 * (the wallet is theirs), and CORS does nothing at all for a non-browser client: anyone
 * who loads this bundle once can read the literal token out of it and replay it directly
 * against the backend from curl/Postman, outside any browser and outside CORS entirely.
 * That is not this token's job to prevent -- `apps/api/src/server.ts` refuses to bind
 * beyond loopback in the first place unless a real, non-client-embedded authentication
 * mechanism is confirmed in front of it (`EXTERNAL_AUTH_IN_FRONT`), which is what actually
 * stands between this token and being replayed by anyone who ever loaded the page.
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
  /** The wallet this session already proved (ADR-0012), or null. Whatever casing it was
   * signed with -- compare case-insensitively against a connected address. */
  verifiedWallet: string | null;
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

/** Exported so tests can simulate a new tab -- a fresh backend session -- by clearing it. */
export const SESSION_KEY = "copilot-session-id";

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

/**
 * Sent on every call, when a signed-in session exists (ADR-0014). Read fresh each
 * time rather than cached: `supabase.auth.getSession()` auto-refreshes an expiring
 * access token internally, so asking right before use -- never holding a stale copy
 * in React state -- is what keeps a long-lived tab from silently sending an expired
 * token.
 */
async function accountHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "x-account-token": token } : {};
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId(),
      ...(await accountHeaders()),
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

export const getSession = (): Promise<SessionState> => call<SessionState>("/session", { headers: authHeaders() });

export const getBoard = (address: string | null): Promise<Board> =>
  call<Board>(`/positions${address ? `?address=${address}` : ""}`, { headers: authHeaders() });

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
  /**
   * The size asked for in contracts rather than dollars. The confirmation offers both,
   * and the server converts -- `sizeUsdc` is still sent (it is what the Trader last had)
   * but is ignored when this is present. Needs `cardRef`: a contract count means nothing
   * until an Order is named.
   */
  contracts?: number;
}): Promise<ProposeResult> =>
  call<ProposeResult>("/propose", {
    method: "POST",
    // No `underlying: "ETH"` default here any more. It used to be spread in ahead of the
    // caller's fields, which meant the surface could not have asked for anything else
    // even once the book opened -- an ETH-only assumption hidden in a spread.
    body: JSON.stringify(body),
    headers: authHeaders(),
  });

/**
 * Natural language chat endpoint: transforms free text into a TradeProposal + explanation.
 */
export const proposeChat = (body: {
  prompt: string;
  cardRef?: string;
}): Promise<ProposeResult & { intent?: TradeIntent; explanation?: string }> =>
  call<ProposeResult & { intent?: TradeIntent; explanation?: string }>("/propose/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: authHeaders(),
  });

/** Step one of proving this wallet is who it says it is (ADR-0012). Signs nothing yet. */
export const requestAuthChallenge = (walletAddress: string): Promise<{ message: string }> =>
  call<{ message: string }>("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ walletAddress }),
    headers: authHeaders(),
  });

/** Step two: hands over the signature /auth/challenge's message produced. */
export const verifyAuthChallenge = (signature: string): Promise<{ walletAddress: string }> =>
  call<{ walletAddress: string }>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ signature }),
    headers: authHeaders(),
  });

/** Asks the backend to build the unsigned transaction(s) this fill needs. Signs nothing. */
export const prepareFill = (proposalId: string, walletAddress: string): Promise<PreparedFill> =>
  call<PreparedFill>("/fill/prepare", {
    method: "POST",
    body: JSON.stringify({ proposalId, walletAddress }),
    headers: authHeaders(),
  });

/**
 * Reports what happened, so the Risk Budget reservation can be finalized or released.
 * `txHash` present means the backend checks the chain itself and decides (ADR-0012);
 * absent means nothing was ever sent, and the reservation is simply released.
 */
export const settleFill = (proposalId: string, txHash?: string): Promise<{ remainingUsdc: number; confirmed: boolean }> =>
  call<{ remainingUsdc: number; confirmed: boolean }>("/fill/settle", {
    method: "POST",
    body: JSON.stringify({ proposalId, txHash }),
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
 * Open a sealed-bid request for a strike the book does not carry (issue #31, ADR-0017).
 *
 * Returns the request already built and the ONE transaction the Trader's own wallet must
 * send to open it. Nothing has been signed at this point and no USDC has moved -- but the
 * Reserve Price is already held against the Risk Budget, because it becomes a real
 * commitment the instant that transaction lands.
 *
 * `strikeOffsetPct` is the slider's own raw number and is never resolved to a dollar
 * strike in this file or anywhere else in the browser: only the server, which alone holds
 * live spot, may turn it into one. The strike comes back inside `ask` already formatted.
 *
 * `kind: "TRADER"` is injected here so the call site in `surface.ts` needs no change --
 * the union discriminant is an implementation detail of the wire shape, not something a
 * caller thinking about a trade needs to name.
 */
export const requestRfq = (body: {
  underlying: UnderlyingSymbol;
  direction: "UP" | "DOWN";
  strikeOffsetPct: number;
  horizonDays: RfqTenorDays;
  sizeUsdc: number;
  walletAddress: string;
}): Promise<PreparedRfq> =>
  call<PreparedRfq>("/rfq", {
    method: "POST",
    body: JSON.stringify({ kind: "TRADER", ...body }),
    headers: authHeaders(),
  });

/**
 * The Cover door's request: a selector, not figures.
 *
 * The body carries an address and nothing else. The server re-reads the Loan off Aave and
 * re-derives the strike, the size and the cap itself, so a stale or tampered browser
 * cannot change what is actually requested (ADR-0006, issue #43).
 *
 * Two shapes come back, and the caller has to look at `status` to tell them apart. A Loan
 * that cannot be covered answers a normal 200 carrying its own refusal -- the same shape
 * `getCoverQuote` uses -- because "this Loan holds two assets" is an answer and not a
 * failure. A coverable Loan answers with the prepared request.
 */
export const requestCoverRfq = (body: {
  address: string;
}): Promise<PreparedRfq | { status: "REFUSED"; refusal: CoverRefusal }> =>
  call<PreparedRfq | { status: "REFUSED"; refusal: CoverRefusal }>("/rfq", {
    method: "POST",
    body: JSON.stringify({ kind: "COVER", ...body }),
    headers: authHeaders(),
  });

/** True when the Cover door answered with a refusal rather than a prepared request. */
export const isCoverRefusal = (
  r: PreparedRfq | { status: "REFUSED"; refusal: CoverRefusal }
): r is { status: "REFUSED"; refusal: CoverRefusal } => "status" in r && r.status === "REFUSED";

/**
 * Report what the wallet did with the opening transaction.
 *
 * A hash means the backend goes and reads the real receipt, and the chain decides whether
 * a request was opened and what id it was given (ADR-0012). No hash means the wallet
 * declined, and the Risk Budget reservation is released.
 */
export const confirmRfq = (
  requestId: string,
  txHash?: string
): Promise<{ opened: boolean; remainingUsdc: number; status?: RfqStatus }> =>
  call("/rfq/confirm", { method: "POST", body: JSON.stringify({ requestId, txHash }), headers: authHeaders() });

/** Where the wait has got to. Polled while the offer window runs. Signs and spends nothing. */
export const getRfqStatus = (requestId: string, signal?: AbortSignal): Promise<RfqStatus> =>
  call<RfqStatus>(`/rfq/${encodeURIComponent(requestId)}`, { headers: authHeaders(), signal });

/**
 * The second human confirmation, prepared.
 *
 * The premium that comes back is a maker's own answer, not an estimate and not the
 * Reserve Price -- which is the whole reason there are two signatures rather than one.
 */
export const prepareRfqSettle = (requestId: string): Promise<PreparedRfqSettle> =>
  call<PreparedRfqSettle>("/rfq/settle/prepare", {
    method: "POST",
    body: JSON.stringify({ requestId }),
    headers: authHeaders(),
  });

/** Report what the wallet did with the settlement. The chain decides again. */
export const settleRfq = (
  requestId: string,
  txHash?: string
): Promise<{ settled: boolean; remainingUsdc: number; status: RfqStatus }> =>
  call("/rfq/settle", { method: "POST", body: JSON.stringify({ requestId, txHash }), headers: authHeaders() });

/** The transaction that withdraws a request nobody answered. */
export const prepareRfqCancel = (requestId: string): Promise<PreparedRfqCancel> =>
  call<PreparedRfqCancel>("/rfq/cancel/prepare", {
    method: "POST",
    body: JSON.stringify({ requestId }),
    headers: authHeaders(),
  });

/** Report the withdrawal. Only a request the chain agrees is closed frees its reservation. */
export const cancelRfq = (
  requestId: string,
  txHash?: string
): Promise<{ cancelled: boolean; remainingUsdc: number }> =>
  call("/rfq/cancel", { method: "POST", body: JSON.stringify({ requestId, txHash }), headers: authHeaders() });

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

/**
 * The Trader's saved Risk Profile, or `null` if they have never chosen one -- not an
 * error, same as an empty board is not an error. Token-gated like /forecast/*.
 */
export const getRiskProfile = (): Promise<RiskProfileName | null> =>
  call<RiskProfileResponse>("/risk-profile", { headers: authHeaders() }).then((r) => r.profile);

/** Saves the Trader's Risk Profile. Asked once; this is also how they change it later. */
export const setRiskProfile = (profile: RiskProfileName): Promise<RiskProfileName> =>
  call<RiskProfileResponse>("/risk-profile", {
    method: "PUT",
    body: JSON.stringify({ profile }),
    headers: authHeaders(),
  }).then((r) => r.profile as RiskProfileName);

/**
 * The ETH Suggestion for the Trader's saved Risk Profile. `profile`/`intent` come back
 * null together when nothing has fired or nothing is saved yet -- not an error, same as
 * `getRiskProfile` returning null. Token-gated, same as /risk-profile.
 */
export const getSuggestion = (): Promise<SuggestionResponse> =>
  call<SuggestionResponse>("/suggestion", { headers: authHeaders() });

/**
 * Records what the Trader did with a Suggestion -- accepted it or dismissed it. Spends
 * nothing and signs nothing (see apps/api/src/app.ts's POST /decisions doc comment):
 * it's a note about their choice, not an act on their behalf. Token-gated and
 * rate-limited on the server like the other DB-touching routes.
 */
export const recordDecision = (body: DecisionRequest): Promise<unknown> =>
  call<unknown>("/decisions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: authHeaders(),
  });

/** The signed-in account's saved settings and linked wallet, if any (ADR-0014). */
export const getAccount = (): Promise<AccountResponse> => call<AccountResponse>("/account");

/** Saves a partial settings update -- only the given fields change. */
export const saveAccountSettings = (
  patch: AccountSettingsRequest
): Promise<{ settings: AccountResponse["settings"] }> =>
  call("/account/settings", { method: "POST", body: JSON.stringify(patch) });

export const getAccountActivity = (): Promise<AccountActivityResponse> =>
  call<AccountActivityResponse>("/account/activity");

/** The History tab: every real Fill this account made, newest first (ADR-0018). */
export const getHistory = (): Promise<HistoryResponse> =>
  call<HistoryResponse>("/history", { headers: authHeaders() });
