"use client";

/**
 * The Risk Profile picker and the Suggestion it drives, as one card -- they are one
 * thought (pick a profile, see what it suggests), not two boxes that happen to sit
 * near each other. Replaces the old RiskProfile.tsx + Suggestion.tsx pair.
 *
 * Merging them also kills the `suggestionRefresh` counter that used to live in
 * Chat.tsx: the Suggestion section here just refetches off its own `profile` state,
 * so a pick or a change refetches by ordinary React data flow, no manual bump needed.
 *
 * `getRiskProfile`/`setRiskProfile`/`getSuggestion`/`recordDecision` (lib/api.ts) are
 * the only way this talks to the server -- no number is ever computed here. The three
 * profile names and their one-line meanings are static copy (apps/agents/README.md's
 * profile table), and `coverSummary` below is server-authored prose, never a number
 * React formats. Nothing here for `no-arithmetic.test.ts` to catch (ADR-0005/0006).
 *
 * Lives in the Insights engine's footer, between the log and the ask-row (Chat.tsx).
 */
import { useEffect, useState } from "react";
import {
  ApiRefusal,
  getRiskProfile,
  getSuggestion,
  recordDecision,
  setRiskProfile,
  type DecisionRequest,
  type RiskProfileName,
  type ProposeResult,
  type SuggestionResponse,
} from "../lib/api";
import { agoShort } from "../lib/clock";
import type { TradeIntent } from "../lib/surface";

const CHOICES: { name: RiskProfileName; label: string; meaning: string }[] = [
  { name: "conservative", label: "Conservative", meaning: "early cover, held longest, highest cost" },
  { name: "balanced", label: "Balanced", meaning: "medium cover, medium cost" },
  { name: "aggressive", label: "Aggressive", meaning: "late cover, shortest hold, lowest cost" },
];

type ProfileStatus = "loading" | "ready" | "error" | "unauthorized";
type SuggestionStatus =
  | "idle"
  | "loading"
  | "no-signal"
  | "ready"
  | "unsupported"
  | "unavailable"
  | "unauthorized"
  | "error";

export function SuggestionCard({
  deal,
  signedIn,
  onAccepted,
}: {
  /** Same signature as `Surface.deal` -- dealt on accept for the Suggestion's own intent. */
  deal: (
    line?: string,
    intent?: Partial<TradeIntent>,
    opts?: { confirm?: boolean }
  ) => Promise<ProposeResult | null>;
  /** Whether an account is signed in (ADR-0017). Gates the Risk Profile -- no wallet required. */
  signedIn: boolean;
  /** Switches Chat to the Trade tab. Called only once accept has actually dealt a Deck. */
  onAccepted: () => void;
}) {
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>("loading");
  const [profile, setProfile] = useState<RiskProfileName | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState<RiskProfileName | null>(null);

  const [sugStatus, setSugStatus] = useState<SuggestionStatus>("idle");
  const [sugData, setSugData] = useState<SuggestionResponse | null>(null);
  const [sugError, setSugError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dealError, setDealError] = useState<string | null>(null);

  useEffect(() => {
    // No account, no request -- the server would 401 anyway now that /risk-profile is
    // keyed on the signed-in account (ADR-0017), not a wallet.
    if (!signedIn) {
      setProfile(null);
      setProfileStatus("unauthorized");
      return;
    }
    let cancelled = false;
    getRiskProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setProfileStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal && e.status === 401) {
          setProfileStatus("unauthorized");
        } else {
          setProfileError(e?.message ?? "Could not load your Risk Profile.");
          setProfileStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // Refetches the Suggestion whenever the saved profile changes -- including the very
  // first time it loads. This is the whole replacement for the old refresh counter: a
  // pick or a change sets `profile`, which is this effect's only dependency.
  useEffect(() => {
    if (!profile) {
      setSugStatus("idle");
      return;
    }
    let cancelled = false;
    setSugStatus("loading");
    setDismissed(false);
    setDealError(null);
    getSuggestion()
      .then((res) => {
        if (cancelled) return;
        setSugData(res);
        setSugStatus(res.intent ? "ready" : "no-signal");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal) {
          if (e.status === 401) setSugStatus("unauthorized");
          else if (e.status === 404) setSugStatus("unsupported");
          else if (e.status === 502 || e.status === 503) setSugStatus("unavailable");
          else {
            setSugError(e.message);
            setSugStatus("error");
          }
        } else {
          setSugError(e?.message ?? "Could not load a Suggestion.");
          setSugStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  async function choose(name: RiskProfileName) {
    setSaving(name);
    setProfileError(null);
    try {
      const saved = await setRiskProfile(name);
      setProfile(saved);
    } catch (e: any) {
      if (e instanceof ApiRefusal && e.status === 401) {
        setProfileStatus("unauthorized");
      } else {
        setProfileError(e?.message ?? "Could not save your Risk Profile.");
      }
    } finally {
      setSaving(null);
    }
  }

  function decisionBody(decision: "ACCEPTED" | "DISMISSED"): DecisionRequest | null {
    const d = sugData;
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
    if (posting || !sugData?.intent) return;
    setPosting(true);
    setDealError(null);
    const intent = sugData.intent;
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

  if (profileStatus === "loading") {
    return (
      <div className="suggestion-card" aria-live="polite">
        <p className="suggestion-card-note">Checking your Risk Profile…</p>
      </div>
    );
  }

  if (profileStatus === "unauthorized") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note">Sign in to save a Risk Profile.</p>
      </div>
    );
  }

  if (profileStatus === "error") {
    return (
      <div className="suggestion-card">
        <p className="suggestion-card-note err">{profileError ?? "Could not load your Risk Profile."}</p>
      </div>
    );
  }

  const selected = CHOICES.find((c) => c.name === profile);

  return (
    <div className="suggestion-card">
      <fieldset className="suggestion-card-profiles" role="radiogroup" aria-label="Choose a Risk Profile">
        <legend>Risk Profile</legend>
        <div className="suggestion-card-profile-row">
          {CHOICES.map((choice) => {
            const isSelected = profile === choice.name;
            return (
              <button
                key={choice.name}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={isSelected ? "is-selected" : undefined}
                disabled={saving !== null}
                onClick={() => void choose(choice.name)}
              >
                {isSelected ? <span aria-hidden="true">✓ </span> : null}
                {choice.label}
                {saving === choice.name ? " …" : ""}
              </button>
            );
          })}
        </div>
        <p className="suggestion-card-meaning">
          {selected ? selected.meaning : "Pick one. Suggestions will follow it."}
        </p>
        {profileError ? <p className="suggestion-card-note err">{profileError}</p> : null}
      </fieldset>

      {profile ? <SuggestionBody
        status={sugStatus}
        data={sugData}
        error={sugError}
        posting={posting}
        dismissed={dismissed}
        dealError={dealError}
        onDismiss={() => void handleDismiss()}
        onAccept={() => void handleAccept()}
      /> : null}
    </div>
  );
}

function SuggestionBody({
  status,
  data,
  error,
  posting,
  dismissed,
  dealError,
  onDismiss,
  onAccept,
}: {
  status: SuggestionStatus;
  data: SuggestionResponse | null;
  error: string | null;
  posting: boolean;
  dismissed: boolean;
  dealError: string | null;
  onDismiss: () => void;
  onAccept: () => void;
}) {
  if (status === "loading") {
    return (
      <div className="suggestion-card-body" aria-live="polite">
        <p className="suggestion-card-note">Checking for a Suggestion…</p>
      </div>
    );
  }

  if (status === "no-signal") {
    return (
      <div className="suggestion-card-body">
        <p className="suggestion-card-note">
          Nothing to suggest right now. The market doesn't clearly favour cover either way.
        </p>
      </div>
    );
  }

  if (status === "unauthorized") {
    return (
      <div className="suggestion-card-body">
        <p className="suggestion-card-note err">Signed out of Suggestions. Refresh to try again.</p>
      </div>
    );
  }

  if (status === "unsupported") {
    return (
      <div className="suggestion-card-body">
        <p className="suggestion-card-note err">ETH Suggestions aren't offered by the Strategy Agent right now.</p>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="suggestion-card-body">
        <p className="suggestion-card-note err">Could not reach the Strategy Agent. Try again shortly.</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="suggestion-card-body">
        <p className="suggestion-card-note err">{error ?? "Could not load a Suggestion."}</p>
      </div>
    );
  }

  if (status !== "ready" || !data?.intent) return null;

  if (dismissed) {
    return (
      <div className="suggestion-card-body suggestion-card-dismissed" aria-live="polite">
        <p className="suggestion-card-note">Dismissed.</p>
      </div>
    );
  }

  const intent = data.intent;
  // strategyName is not displayed (the selected Risk Profile button above already
  // names the profile) but still rides into decisionBody -> POST /decisions below,
  // since the Decision log is where a strategy identifier actually matters.
  const coin = intent.underlying;
  const directionCopy = `${coin} ${intent.direction === "DOWN" ? "falling" : "rising"}`;
  const coverSummary = data.coverSummary ?? `Cover against ${directionCopy}.`;
  const pointCopy =
    intent.direction === "DOWN" ? `Protects ${coin} if the price drops` : `Protects ${coin} if the price rises`;
  const bandCopy = data.marketBand === "weak" ? "weak market" : data.marketBand === "calm" ? "calm market" : null;
  const firedAtMs = data.firedAt ? Date.parse(data.firedAt) : null;
  const freshness = firedAtMs !== null && !Number.isNaN(firedAtMs) ? agoShort(firedAtMs, Date.now()) : null;

  return (
    <div className="suggestion-card-body suggestion-card-ready" aria-live="polite">
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
        <button type="button" className="suggestion-card-primary" onClick={onAccept} disabled={posting}>
          See what this buys
        </button>
        <button type="button" className="suggestion-card-dismiss" onClick={onDismiss} disabled={posting}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
