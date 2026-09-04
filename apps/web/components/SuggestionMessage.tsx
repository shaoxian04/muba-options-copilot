"use client";

/**
 * The Suggestion itself, rendered as one message inside the Insights log -- split out
 * of the old SuggestionCard.tsx, which pinned this beside the Risk Profile picker in a
 * footer that changed height every time a Suggestion loaded. The picker now lives in
 * RiskProfileChip.tsx; this component only renders what a fetch (owned by Chat.tsx's
 * InsightsEngine, keyed on the resolved profile) already found.
 *
 * `recordDecision`/`deal` (lib/api.ts, lib/surface.ts) are the only way this talks to
 * the server or the money path -- no number is ever computed here (ADR-0006).
 */
import { useState } from "react";
import { ApiRefusal, recordDecision, type DecisionRequest, type ProposeResult, type SuggestionResponse } from "../lib/api";
import { agoShort } from "../lib/clock";
import type { TradeIntent } from "../lib/surface";

export type SuggestionStatus =
  | "loading"
  | "no-signal"
  | "ready"
  | "unsupported"
  | "unavailable"
  | "unauthorized"
  | "error";

export function SuggestionMessage({
  status,
  data,
  error,
  deal,
  onAccepted,
}: {
  status: SuggestionStatus;
  data: SuggestionResponse | null;
  error: string | null;
  /** Same signature as `Surface.deal` -- dealt on accept for the Suggestion's own intent. */
  deal: (
    line?: string,
    intent?: Partial<TradeIntent>,
    opts?: { confirm?: boolean }
  ) => Promise<ProposeResult | null>;
  /** Switches Chat to the Trade tab. Called only once accept has actually dealt a Deck. */
  onAccepted: () => void;
}) {
  const [posting, setPosting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dealError, setDealError] = useState<string | null>(null);

  function decisionBody(decision: "ACCEPTED" | "DISMISSED"): DecisionRequest | null {
    const d = data;
    if (!d?.strategyId || !d.strategyName || !d.firedAt || !d.intent) return null;
    return { strategyId: d.strategyId, strategyName: d.strategyName, firedAt: d.firedAt, intent: d.intent, decision };
  }

  async function handleDismiss() {
    if (posting) return;
    setPosting(true);
    const body = decisionBody("DISMISSED");
    try {
      if (body) await recordDecision(body);
    } catch {
      // A failed log write doesn't change what the Trader chose -- they dismissed it
      // either way, and nothing downstream reads this POST's result.
    } finally {
      setPosting(false);
      setDismissed(true);
    }
  }

  async function handleAccept() {
    if (posting || !data?.intent) return;
    setPosting(true);
    setDealError(null);
    const intent = data.intent;
    const body = decisionBody("ACCEPTED");
    // What the deal actually produced. Read rather than inferred from a thrown error:
    // `ask` swallows an ApiRefusal and `loadDeck` catches everything (lib/surface.ts),
    // so a 503 from /propose, a VETO and a NO_ORDER all resolve normally. Only a
    // PROPOSAL means the Trader has something to look at.
    let answer: ProposeResult | null = null;
    try {
      // Accept must never spend. This records the Trader's intent, deals a fresh Deck
      // and opens the confirmation on it -- Confirm still has to be pressed before any
      // signature happens (ADR-0008).
      // All four fields, never a subset: the book is multi-asset now, and a Suggestion
      // made on ETH dealt against whichever Underlying the rail has selected is a trade
      // nobody suggested.
      answer = await deal(undefined, {
        underlying: intent.underlying,
        direction: intent.direction,
        sizeUsdc: intent.sizeUsdc,
        horizonDays: intent.horizonDays,
      }, { confirm: true });
    } catch {
      answer = null;
    }

    const dealt = answer?.kind === "PROPOSAL";
    // Stay on Insights when nothing was dealt, so the Trader reads the reason where
    // they pressed rather than landing on a Trade tab with no proposal on it.
    if (dealt) onAccepted();
    else setDealError("Could not deal that Suggestion. Try again from the Deck.");

    try {
      // Only a dealt Suggestion is an ACCEPTED one. Logging the press itself would put
      // a false positive in /decisions/stats every time the book or the agents service
      // was having a bad minute -- twice, once the Trader retried.
      if (dealt && body) await recordDecision(body);
    } catch {
      // Same reasoning as Dismiss: a failed log write must never block the trade
      // intent itself, which has already been dealt (or not) above.
    } finally {
      setPosting(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="suggestion-card" aria-live="polite">
        <p className="suggestion-card-note">Checking for a Suggestion…</p>
      </div>
    );
  }

  if (status === "no-signal") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note">
          Nothing to suggest right now. The market doesn't clearly favour cover either way.
        </p>
      </div>
    );
  }

  if (status === "unauthorized") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note err">Signed out of Suggestions. Refresh to try again.</p>
      </div>
    );
  }

  if (status === "unsupported") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note err">Suggestions only cover ETH for now. Nothing to show yet.</p>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note err">Could not reach the Strategy Agent. Try again shortly.</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note err">{error ?? "Could not load a Suggestion."}</p>
      </div>
    );
  }

  if (status !== "ready" || !data?.intent) return null;

  if (dismissed) {
    return (
      <div className="suggestion-card suggestion-card-dismissed" aria-live="polite">
        <p className="suggestion-card-note">Dismissed.</p>
      </div>
    );
  }

  const intent = data.intent;
  const coin = intent.underlying;
  const directionCopy = `${coin} ${intent.direction === "DOWN" ? "falling" : "rising"}`;
  const coverSummary = data.coverSummary ?? `Cover against ${directionCopy}.`;
  const pointCopy =
    intent.direction === "DOWN" ? `Protects ${coin} if the price drops` : `Protects ${coin} if the price rises`;
  const bandCopy = data.marketBand === "weak" ? "weak market" : data.marketBand === "calm" ? "calm market" : null;
  const firedAtMs = data.firedAt ? Date.parse(data.firedAt) : null;
  const freshness = firedAtMs !== null && !Number.isNaN(firedAtMs) ? agoShort(firedAtMs, Date.now()) : null;

  return (
    <div className="suggestion-card suggestion-card-ready" aria-live="polite">
      {bandCopy ? <p className="suggestion-card-band">{bandCopy}</p> : null}
      <p className="suggestion-card-point">{pointCopy}</p>
      {freshness ? (
        <p className="suggestion-card-caveat">
          {coin} daily close, <time dateTime={data.firedAt ?? undefined}>{freshness}</time>
        </p>
      ) : null}
      <p className="suggestion-card-blurb">{coverSummary}</p>
      <p className={`suggestion-card-note${dealError ? " err" : ""}`}>
        {dealError ?? "No numbers yet. They show up if you continue."}
      </p>
      <div className="suggestion-card-actions">
        <button type="button" className="suggestion-card-primary" onClick={() => void handleAccept()} disabled={posting}>
          See what this buys
        </button>
        <button type="button" className="suggestion-card-dismiss" onClick={() => void handleDismiss()} disabled={posting}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
