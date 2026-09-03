// apps/web/components/NearestOrderPreview.tsx
"use client";

/**
 * Shown under a card-drop analysis answer (Chat.tsx) once the AI states a predicted
 * price range and direction for that coin: searches the live order book for whichever
 * order's strike sits closest to the middle of that range, across every expiry
 * currently trading in the AI's predicted direction -- not just the expiry the dropped
 * card itself was on.
 *
 * Deliberately narrow about what crosses from opinion into the trade flow (ADR-0005):
 * this never shows a premium, a contract count, or a Max Loss -- only the strike,
 * direction and expiry a Trader already reads off any ordinary Deck card. The first
 * real economics appear only once "Place order" opens the one real ConfirmModal, priced
 * fresh off the SDK exactly like every other order in the product.
 */
import { useEffect, useState } from "react";
import { getDeck, type UnderlyingSymbol } from "../lib/api";
import { STAKE_USDC, type Direction } from "../lib/surface";
import { nearestOrder, type OrderCandidate } from "../lib/nearestOrder";

type Status = "loading" | "no-direction" | "no-live-orders" | "error" | "ready";

export function NearestOrderPreview({
  underlying,
  predictedDirection,
  predictedRange,
  probeHorizonDays,
  pick,
}: {
  underlying: UnderlyingSymbol;
  predictedDirection: "up" | "down" | "flat";
  predictedRange: { low: number; high: number } | undefined;
  /** The dropped card's own expiry -- the search's starting point for discovering which other expiries are live for this direction. */
  probeHorizonDays: number;
  pick: (cardRef: string, on: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [match, setMatch] = useState<(OrderCandidate & { direction: Direction }) | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    if (predictedDirection === "flat" || !predictedRange) {
      setStatus("no-direction");
      setMatch(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setMatch(null);

    const direction: Direction = predictedDirection === "up" ? "UP" : "DOWN";
    const midpoint = (predictedRange.low + predictedRange.high) / 2;

    void (async () => {
      try {
        const first = await getDeck({ asset: underlying, direction, horizonDays: probeHorizonDays, sizeUsdc: STAKE_USDC });
        const liveHorizons = first.expiries.filter((e) => e.live).map((e) => e.horizonDays);
        const rest = liveHorizons.filter((h) => h !== first.horizonDays);
        const others = await Promise.all(
          rest.map((h) =>
            getDeck({ asset: underlying, direction, horizonDays: h, sizeUsdc: STAKE_USDC }).catch(() => null)
          )
        );
        if (cancelled) return;

        const decks = [first, ...others.filter((d): d is NonNullable<typeof d> => d !== null)];
        const candidates: OrderCandidate[] = decks.flatMap((d) =>
          d.cards.map((c) => ({
            cardRef: c.cardRef,
            strike: c.strike,
            horizonDays: d.horizonDays,
            expiryDisplay: d.expiry?.display ?? null,
          }))
        );
        const best = nearestOrder(candidates, midpoint);
        if (!best) {
          setStatus("no-live-orders");
          return;
        }
        setMatch({ ...best, direction });
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [underlying, predictedDirection, predictedRange?.low, predictedRange?.high, probeHorizonDays]);

  async function handlePlace() {
    if (!match || placing) return;
    setPlacing(true);
    try {
      await pick(match.cardRef, { underlying, direction: match.direction, horizonDays: match.horizonDays });
    } finally {
      setPlacing(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="coin-detail" aria-live="polite">
        <span className="lbl">Closest order</span>
        <span className="suggestion-card-note">Searching the live book…</span>
      </div>
    );
  }

  if (status === "no-direction") {
    return (
      <div className="coin-detail" aria-live="polite">
        <span className="lbl">Closest order</span>
        <span className="suggestion-card-note">No clear predicted direction to match a strike against.</span>
      </div>
    );
  }

  if (status === "no-live-orders" || status === "error") {
    return (
      <div className="coin-detail" aria-live="polite">
        <span className="lbl">Closest order</span>
        <span className="suggestion-card-note">
          {status === "error" ? "Could not search the live book right now." : "Nothing is live in that direction right now."}
        </span>
      </div>
    );
  }

  const payWord = match!.direction === "DOWN" ? "pays below" : "pays above";

  return (
    <div className="coin-detail" data-testid="nearest-order-preview" aria-live="polite">
      <span className="lbl">Closest order</span>
      <span className="suggestion-card-point">
        {match!.strike.display}, {payWord}
        {match!.expiryDisplay ? `, expires ${match!.expiryDisplay}` : ""}
      </span>
      <button
        type="button"
        className="suggestion-card-primary"
        onClick={() => void handlePlace()}
        disabled={placing}
        data-testid="nearest-order-place"
      >
        {placing ? "Opening…" : "Place order"}
      </button>
    </div>
  );
}
