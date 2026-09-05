"use client";

/**
 * A dropped Deck Card's analysis, as a card rather than an essay.
 *
 * The question a drop asks is "the market prices this at 6% -- is that fair?", so the
 * two probabilities are the headline and everything else is evidence beneath them. What
 * used to render here was `r.answer` as one unbroken paragraph followed by three more
 * paragraphs that flattened already-structured data (`RSI(14) 62.4, SMA(20) $2,388,
 * EMA(20) $2,401`) back into prose.
 *
 * ADR-0005 is why there is no verdict badge. "OVERPRICED" or "LOOKS CHEAP" a few pixels
 * above `NearestOrderPreview`'s Place order button is an opinion sitting where a Max
 * Loss is about to be, which is the exact adjacency that decision exists to prevent.
 * Two observations side by side -- what the market prices, what the AI predicted -- let
 * the Trader draw the conclusion instead, and neither is a number this file invented:
 * the market's chance is the Card's own `impliedChanceDisplay`, and the range is the
 * forecast's own. The only arithmetic is `strikeBand`, which returns CSS percentages
 * (see `lib/geometry.ts` for why that is allowed there and nowhere else).
 */
import type { CoinAskResult } from "../lib/api";
import type { InsightsLine } from "../lib/insightsHistory";
import { strikeBand } from "../lib/geometry";
import type { StrikeOutlook } from "../lib/strikeOutlook";

type CardContext = NonNullable<InsightsLine["cardContext"]>;

/**
 * The dropped Card, restated in one line.
 *
 * Replaces the 40-word question `buildCardQuestion` writes for the extractor. Every
 * value is a string the Card was already showing on the Deck -- nothing is fetched and
 * nothing is derived.
 */
export function CardEcho({ card }: { card: CardContext }) {
  return (
    <div className="ins-echo" data-testid="insight-echo">
      <span className="sym">{card.underlying}</span>
      <span className={`dir ${card.direction === "DOWN" ? "down" : "up"}`}>
        {card.direction === "DOWN" ? "falls to" : "rises to"} {card.strikeDisplay}
      </span>
      <span className="dot">·</span>
      <span className="k">{card.horizonDays === 1 ? "1 day" : `${card.horizonDays} days`}</span>
      {card.impliedChanceDisplay ? (
        <>
          <span className="dot">·</span>
          <span className="k">{card.impliedChanceDisplay}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Strike, predicted range and spot on one axis.
 *
 * The band carries FIGURES only and the words live in the legend below it: at the 344px
 * the panel is actually rendered at, a "$2,340 strike" label and a "$2,400-$2,620
 * predicted" label overlap the moment either carries a trailing word. Found by building
 * it, not by reasoning about it.
 */
function Band({ card, price, spotValue }: { card: CardContext; price: NonNullable<CoinAskResult["price"]>; spotValue: number }) {
  const b = strikeBand(card.strikeValue, price.predictedRange.low, price.predictedRange.high, spotValue);

  return (
    <div className="ins-band-wrap">
      <div className="ins-band" data-testid="insight-band" aria-hidden="true">
        <div className="axis" />
        <div className="rng" style={{ left: `${b.range.left}%`, width: `${b.range.width}%` }} />
        <div className="spot" style={{ left: `${b.spotX}%` }} />
        <div className="strike" style={{ left: `${b.strikeX}%` }} />
        <span className="tag st" style={{ left: `${b.strikeX}%` }}>
          {card.strikeDisplay}
        </span>
        <span className="tag rl" style={{ left: `${b.rangeMidX}%` }}>
          {price.predictedRange.low}–{price.predictedRange.high}
        </span>
      </div>
      <div className="ins-legend">
        <span>
          <i className="sw strike" />
          your strike
        </span>
        <span>
          <i className="sw rng" />
          predicted range
        </span>
        <span>
          <i className="sw spot" />
          spot now
        </span>
      </div>
    </div>
  );
}

/**
 * Where the strike fell relative to the forecast, in words. Factual, never a judgment --
 * it says where the number sits, never whether that makes the Card a good buy.
 *
 * The Card's own payout condition ("pays if ETH falls to or below that level") used to
 * be spliced on here; it now lives in the echo at the top of the card, which states the
 * same thing once instead of twice.
 */
function outlookPhrase(outlook: StrikeOutlook): string | null {
  if (outlook.position === "unavailable") return null;
  if (outlook.position === "inside") return "inside its predicted range";
  return outlook.position === "below-range" ? "below its predicted range" : "above its predicted range";
}

export function InsightCard({
  symbol,
  result,
  card,
  outlook,
  children,
}: {
  symbol: string;
  result: CoinAskResult;
  /** Null for an ordinary typed question -- the card then renders as a plain answer. */
  card: CardContext | null;
  outlook: StrikeOutlook | null;
  /** `NearestOrderPreview`, when there is one. Rendered last, above the disclaimer. */
  children?: React.ReactNode;
}) {
  const price = result.price;
  const phrase = outlook && card ? outlookPhrase(outlook) : null;
  // The forecast's own grounding price, never re-derived: `groundedOn` is the MarketData
  // the prediction was actually made against, so the band and the prose agree by
  // construction rather than by luck.
  const spotValue = price?.groundedOn.price ?? result.market?.price ?? null;

  if (result.error) {
    return (
      <div className="coin-answer">
        <strong>{symbol}: </strong>
        <span className="err">{result.error}</span>
      </div>
    );
  }

  // A typed question with no card behind it keeps the old plain-prose shape: the
  // comparison this card is built around needs a strike to compare, and inventing a
  // headline for a question like "how is ETH doing" would be a card with nothing in it.
  if (!card) {
    return (
      <div className="coin-answer">
        <strong>{symbol}: </strong>
        <span>{result.answer}</span>
        {price ? (
          <div className="coin-detail">
            <span className="lbl">Price outlook</span>
            <span>
              {price.direction}, predicted {price.predictedRange.low}–{price.predictedRange.high}, confidence{" "}
              {price.confidence}. {price.rationale}
            </span>
          </div>
        ) : null}
        {result.riskBenefit ? (
          <div className="coin-detail">
            <span className="lbl">Risk / benefit</span>
            <span>
              Upside: {result.riskBenefit.upside} Downside: {result.riskBenefit.downside}
            </span>
          </div>
        ) : null}
        {result.indicators ? (
          <div className="coin-detail">
            <span className="lbl">Indicators</span>
            <span>
              RSI(14) {result.indicators.rsi14 ?? "n/a"}, SMA(20) {result.indicators.sma20 ?? "n/a"}, EMA(20){" "}
              {result.indicators.ema20 ?? "n/a"}
            </span>
          </div>
        ) : null}
        {children}
        {result.disclaimer ? <div className="disclaimer">{result.disclaimer}</div> : null}
      </div>
    );
  }

  return (
    <div className="ins-card" data-testid="insight-card">
      <div className="ins-card-hd">
        <span className="ins-card-k">You dropped</span>
        <CardEcho card={card} />
      </div>

      <div className="ins-cmp">
        <div>
          <span className="k">Market says</span>
          {/* Absent only for a log entry restored from sessionStorage that predates this
              field -- never blank for a drop made today. */}
          {card.impliedChanceDisplay ? (
            <>
              <span className="big">{card.impliedChanceDisplay}</span>
              <span className="sub">chance it pays</span>
            </>
          ) : (
            <span className="ai muted">Not carried on this card.</span>
          )}
        </div>
        {/*
          This IS the strike-vs-range comparison the card drop exists to get -- the same
          fact the old prose line spelled out, moved into the headline where the question
          is actually asked. It keeps that name so the test which has always guarded
          "a drop gets this comparison, a typed question never does" still guards it.
        */}
        <div data-testid="strike-outlook">
          <span className="k">The AI&rsquo;s view</span>
          {price ? (
            <>
              <span className="ai">
                Strike sits {phrase ? <em>{phrase}</em> : <>outside what it predicted</>}
              </span>
              <span className="sub">{price.confidence} confidence</span>
            </>
          ) : (
            <span className="ai muted">No price forecast for this horizon.</span>
          )}
        </div>
      </div>

      {price && spotValue !== null ? <Band card={card} price={price} spotValue={spotValue} /> : null}

      {result.indicators || price ? (
        <div className="ins-chips">
          {result.indicators?.rsi14 != null ? (
            <span className="ins-chip">
              RSI(14) <b>{result.indicators.rsi14}</b>
            </span>
          ) : null}
          {result.indicators?.sma20 != null ? (
            <span className="ins-chip">
              20d SMA <b>{result.indicators.sma20}</b>
            </span>
          ) : null}
          {result.indicators?.ema20 != null ? (
            <span className="ins-chip">
              20d EMA <b>{result.indicators.ema20}</b>
            </span>
          ) : null}
          {price ? (
            <span className="ins-chip">
              outlook <b>{price.direction}</b>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* The essay, one click away rather than the first thing on screen. Still the
          whole answer -- demoted, never truncated. */}
      <details className="ins-why">
        <summary>Why</summary>
        <p>{result.answer}</p>
        {result.riskBenefit ? (
          <>
            <p>
              <strong>Upside.</strong> {result.riskBenefit.upside}
            </p>
            <p>
              <strong>Downside.</strong> {result.riskBenefit.downside}
            </p>
          </>
        ) : null}
        {price ? (
          <p>
            <strong>Price outlook.</strong> {price.rationale}
          </p>
        ) : null}
      </details>

      {children}
      {result.disclaimer ? <div className="disclaimer">{result.disclaimer}</div> : null}
    </div>
  );
}
