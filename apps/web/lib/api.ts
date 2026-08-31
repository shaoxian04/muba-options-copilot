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
import type { Card, Deck, Figure, Holding, ProposeResult } from "@copilot/shared";

export type { Card, Deck, Figure, Holding, ProposeResult };

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:3001";

/**
 * The bearer token `/fill` requires whenever one is configured.
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

export const getDeck = (q: { direction: "UP" | "DOWN"; horizonDays: number; sizeUsdc: number }): Promise<Deck> =>
  call<Deck>(`/deck?direction=${q.direction}&horizonDays=${q.horizonDays}&sizeUsdc=${q.sizeUsdc}`);

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
  direction: "UP" | "DOWN";
  horizonDays: number;
  sizeUsdc: number;
  cardRef?: string;
}): Promise<ProposeResult> =>
  call<ProposeResult>("/propose", {
    method: "POST",
    body: JSON.stringify({ underlying: "ETH", ...body }),
  });

/** Spends real USDC. Only ever called from the Trader's own press on Confirm. */
export const fill = (proposalId: string): Promise<FillReceipt> =>
  call<FillReceipt>("/fill", {
    method: "POST",
    body: JSON.stringify({ proposalId }),
    ...(API_TOKEN ? { headers: { authorization: `Bearer ${API_TOKEN}` } } : {}),
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
