"use client";

/**
 * The Deck: every Order the Trader may buy right now, as Cards they can compare.
 *
 * Issue #29 -- each Card is a labelled data sheet, not a shape to decode. Every figure
 * is named: the strike leads, a signed distance line says how far the Underlying has to
 * move (or that it has already passed and must instead STAY), four labelled rows give
 * the premium, the stake's contracts, Maker Depth and who else holds the strike, and the
 * footer runs a live countdown to expiry. Implied Chance survives the beginner pass
 * under the surface label "chance it pays" -- drawn as a dial, given as a number, and
 * said in words, so the Card carries its meaning with colour removed entirely.
 *
 * Nothing here is decoration:
 *
 *   - The rail's colour is the Card's direction (call/put, blue/orange) -- identity, not
 *     a second reading of Implied Chance. Implied Chance lives on the dial alone now.
 *   - `distance.sentence`, `chanceLabel` and every other figure are the server's own
 *     strings, rendered verbatim. The one sentence this file reads apart is
 *     `distance.sentence` itself, split at its own length so the numeral or "must stay"
 *     can be bolded -- no wording is invented here, only where the split falls.
 *   - Maker Depth's proportional bar and the dial's arc are coordinates from
 *     `lib/geometry.ts`, never text.
 *
 * Every number rendered is a `display` string. There is no arithmetic in this file, and
 * `tests/support/no-arithmetic.test.ts` fails if any appears.
 */
import { useEffect, useRef } from "react";
import type { Card, Deck } from "@copilot/shared";
import { countdown, countdownWords } from "../lib/clock";
import { depthBarWidths } from "../lib/geometry";
import { CARD_DRAG_MIME, type DroppedCard } from "../lib/cardQuestion";
import { Dial } from "./Dial";

function CardTile({
  card,
  direction,
  asset,
  horizonDays,
  selected,
  dealt,
  depthWidth,
  now,
  onPick,
  disabled,
  innerRef,
}: {
  card: Card;
  direction: Deck["direction"];
  asset: Deck["asset"];
  horizonDays: Deck["horizonDays"];
  selected: boolean;
  dealt: boolean;
  depthWidth: string;
  now: number;
  onPick: () => void;
  disabled: boolean;
  /** Set on the dealt Card only, so DeckRow can scroll it into view. */
  innerRef?: (el: HTMLButtonElement | null) => void;
}) {
  // From the Deck's own direction. Reading it off `payoutAsset` would work only while
  // puts settle in USDC and inverse calls in WETH -- a coincidence of today's book, not
  // a fact about which way the Card pays.
  const pays = direction === "DOWN" ? "pays below" : "pays above";
  const railColour = direction === "DOWN" ? "var(--put)" : "var(--call)";

  /*
   * The distance line, bolded where the number is.
   *
   * `distance.sentence` is the server's whole sentence -- "must fall 3.5%" or "already
   * below — must stay" -- written in `apps/api/src/thetanuts/distance.ts` because
   * deciding when a percentage becomes "already past" is arithmetic on a signed figure
   * (ADR-0006, issue #24). Nothing here recomputes that: `alreadyPast` picks which tail
   * to bold -- the server's own flag for exactly this -- and `sentence.slice` finds
   * where that tail starts by its length, not by inventing new wording.
   */
  const distanceBold = card.distance.alreadyPast ? "must stay" : card.distance.needed.display;
  const distancePrefix = card.distance.sentence.slice(0, card.distance.sentence.length - distanceBold.length);

  // "1 offer" vs "3 offers", "1 trader" vs "4 traders" -- a word chosen by comparing the
  // server's own count to one, the same way `pays` above chooses a word from `direction`.
  // The count itself is never touched: `depthOrders.display` and `heldCount.display` are
  // rendered verbatim.
  const offerWord = card.depthOrders.value === 1 ? "offer" : "offers";
  const heldWord = card.heldCount && card.heldCount.value === 1 ? "trader" : "traders";

  return (
    <li>
      <button
        ref={innerRef}
        type="button"
        className={`card${dealt ? " dealt" : ""}`}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onPick}
        draggable={!disabled}
        onDragStart={(e) => {
          // The drop target (Task 4) rebuilds its question from these fields alone --
          // every value here is already on `card`/`direction` or the Deck props passed
          // down, never re-derived or formatted anew.
          const payload: DroppedCard = {
            underlying: asset,
            direction,
            horizonDays,
            strikeValue: card.strike.value,
            strikeDisplay: card.strike.display,
            impliedChanceDisplay: card.impliedChance.display,
            perContractDisplay: card.perContractUsd.display,
          };
          e.dataTransfer.setData(CARD_DRAG_MIME, JSON.stringify(payload));
          e.dataTransfer.effectAllowed = "copy";
        }}
        data-testid="card"
        data-card-ref={card.cardRef}
        data-chance={card.impliedChance.display}
        /*
         * The whole Card said once, in order, for a screen reader: the strike and
         * direction, how far it has to move, the chance it pays in words as well as a
         * number, what it costs, what it buys, Maker Depth, who else holds it, break
         * even, and when it expires. Reading the visual fragments in DOM order would
         * teach nobody anything.
         */
        aria-label={
          `Strike ${card.strike.display}, ${pays}. ${card.distance.sentence}. ` +
          `Chance it pays ${card.impliedChance.display}, ${card.chanceLabel}. ` +
          `Premium ${card.perContractUsd.display} per contract. ` +
          `${card.contracts.display} contracts for ${card.premiumUsdc.display}, settling in ${card.payoutAsset}. ` +
          `Maker depth ${card.depthUsdc.display} across ${card.depthOrders.display} ${offerWord}. ` +
          (card.heldCount
            ? `${card.heldCount.display} ${heldWord} hold this strike. `
            : "Nobody holds this strike yet. ") +
          `Break even at ${card.breakevenPrice.display}. ` +
          `Expires ${card.expiry.display}, ${countdownWords(card.expiry.value, now)}.`
        }
      >
        <i className="rail" aria-hidden="true" style={{ background: railColour }} />

        <div className="etop" aria-hidden="true">
          <div>
            <div className="k hero">{card.strike.display}</div>
            <div className="dist">
              {distancePrefix}
              <b>{distanceBold}</b>
            </div>
          </div>
          <div className="ch">
            <Dial chance={card.impliedChance.value} band={card.chanceBand} size={46} display={card.impliedChance.display} />
            <small className="lbl">
              chance
              <br />
              it pays
            </small>
            {/* The number lives on the dial; this is the same chance said in words, so
                the Card carries its meaning with colour removed entirely (issue #10, #29). */}
            <div className="words">{card.chanceLabel}</div>
          </div>
        </div>

        <dl aria-hidden="true">
          <dt>Premium</dt>
          <dd>
            {card.perContractUsd.display} <span className="u">/ contract</span>
          </dd>

          <dt>You pay</dt>
          <dd>
            {card.premiumUsdc.display} <span className="u">for {card.contracts.display} contracts</span>
          </dd>

          <dt>Maker depth</dt>
          <dd>
            <span className="hbar">
              <i style={{ width: depthWidth }} />
            </span>
            {card.depthUsdc.display}{" "}
            <span className="u">
              · {card.depthOrders.display} {offerWord}
            </span>
          </dd>

          <dt>Held now</dt>
          <dd>
            {card.heldCount ? (
              <>
                {card.heldCount.display} <span className="u">{heldWord}</span>
              </>
            ) : (
              <span className="u">nobody yet</span>
            )}
          </dd>
        </dl>

        <div className="efoot" aria-hidden="true">
          <span className="lbl">expires in</span>
          <span className="clk" data-testid="card-countdown">
            {countdown(card.expiry.value, now)}
          </span>
        </div>
      </button>
    </li>
  );
}

export function DeckRow({
  deck,
  selectedRef,
  dealtRef,
  busy,
  now,
  onPick,
}: {
  deck: Deck;
  selectedRef: string | null;
  dealtRef: string | null;
  busy: boolean;
  now: number;
  onPick: (cardRef: string) => void;
}) {
  // One strike's Maker Depth read against the deepest in this same Deck -- a width, not
  // a figure. `depthBarWidths` is the one place this ratio is computed, in `lib/
  // geometry.ts`, so this file stays free of the `Math.max` that finding "deepest" needs.
  const depthWidths = depthBarWidths(deck.cards.map((c) => c.depthUsdc.value));

  /*
    A dealt Card can sit several rows down, where the tag above the Deck points at
    something off screen. Bring it into view once -- `block: "nearest"` so a Card that
    is already visible does not move the page at all.

    `deck` is a dependency because the Card usually arrives a render AFTER the ref does:
    accepting a Suggestion sets `dealtRef` and reloads the Deck at the proposal's own
    expiry, so the element does not exist yet on the first run. `scrolledTo` is what
    keeps that from re-scrolling on every six-second poll tick.
  */
  const dealtEl = useRef<HTMLButtonElement | null>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!dealtRef) {
      scrolledTo.current = null;
      return;
    }
    if (scrolledTo.current === dealtRef || !dealtEl.current) return;
    scrolledTo.current = dealtRef;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dealtEl.current.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [dealtRef, deck]);

  return (
    <div className="well">
      {deck.gradientLegible ? null : (
        <p className="note" data-testid="gradient-fallback">
          These are all about as likely as each other, so the shading is not telling you much today. Each card says
          where it stands in words.
        </p>
      )}
      <ul
        className="deck"
        data-testid="deck"
        aria-label={`Options you can buy, longest shot first${deck.expiry ? `, all ending ${deck.expiry.display}` : ""}`}
      >
        {deck.cards.map((card, i) => (
          <CardTile
            key={card.cardRef}
            card={card}
            direction={deck.direction}
            asset={deck.asset}
            horizonDays={deck.horizonDays}
            selected={card.cardRef === selectedRef}
            dealt={card.cardRef === dealtRef}
            depthWidth={depthWidths[i] ?? "6%"}
            now={now}
            disabled={busy}
            onPick={() => onPick(card.cardRef)}
            innerRef={card.cardRef === dealtRef ? (el) => { dealtEl.current = el; } : undefined}
          />
        ))}
      </ul>
    </div>
  );
}
