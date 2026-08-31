"use client";

/**
 * The Deck: every Order the Trader may buy right now, as cards they can compare.
 *
 * The headline is the market's own Implied Chance that the contract pays out, drawn as
 * a fill rising from the bottom of the card. Read across the row it is a gradient from
 * cheap long shots to expensive likely ones -- which is the trade-off an options-naive
 * person most needs to see, made visible without a sentence of explanation.
 *
 * Three things here are not decoration:
 *
 *   - The rail's height is `impliedChance.value` and its colour is `chanceBand`, both
 *     from the server. React quantises nothing.
 *   - Every card carries `chanceLabel` in words, so removing colour entirely -- a
 *     screen reader, deuteranopia, a printout -- loses no information.
 *   - When the server says the Deck's chances have compressed into a narrow band, the
 *     gradient has stopped carrying information and the words are promoted from a
 *     caption to the card's second line.
 *
 * Every number rendered is a `display` string. There is no arithmetic in this file, and
 * `tests/support/no-arithmetic.test.ts` fails if any appears.
 */
import type { Card, Deck } from "@copilot/shared";
import { fillHeight } from "../lib/geometry";

/** The ramp is defined in `globals.css` and held to a contrast bar by `tests/support/ramp.test.ts`. */
const rampColour = (band: number) => `var(--r${band})`;

function CardTile({
  card,
  direction,
  selected,
  dealt,
  gradientLegible,
  onPick,
  disabled,
}: {
  card: Card;
  direction: Deck["direction"];
  selected: boolean;
  dealt: boolean;
  gradientLegible: boolean;
  onPick: () => void;
  disabled: boolean;
}) {
  // From the Deck's own direction. Reading it off `payoutAsset` would work only while
  // puts settle in USDC and inverse calls in WETH -- a coincidence of today's book, not
  // a fact about which way the Card pays.
  const pays = direction === "DOWN" ? "pays below" : "pays above";

  return (
    <li>
      <button
        type="button"
        className={`card${dealt ? " dealt" : ""}`}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onPick}
        data-testid="card"
        data-card-ref={card.cardRef}
        data-chance={card.impliedChance.display}
        /*
         * The whole card said once, in order, for a screen reader: what it costs, what
         * it buys, what it pays in, and how likely it is. Reading the visual fragments
         * in DOM order would give "38 % chance $2,360.00 pays below" and teach nobody
         * anything.
         */
        aria-label={
          `Strike ${card.strike.display}, ${pays}. ` +
          `Implied Chance ${card.impliedChance.display}, ${card.chanceLabel}. ` +
          `${card.contracts.display} contracts for ${card.premiumUsdc.display}, ` +
          `settling in ${card.payoutAsset}. Break even at ${card.breakevenPrice.display}.`
        }
      >
        {/*
          Two drawings of one band. The rail is at full opacity and carries the
          comparison; the tint is a wash and carries the glance. Nothing is printed on
          the rail, which is the only reason it can be saturated enough to tell apart --
          see the note at the top of `globals.css`.
        */}
        <i
          className="rail"
          aria-hidden="true"
          style={{ height: fillHeight(card.impliedChance.value), background: rampColour(card.chanceBand) }}
          data-band={card.chanceBand}
        />
        <i
          className="tint"
          aria-hidden="true"
          style={{ height: fillHeight(card.impliedChance.value), background: rampColour(card.chanceBand) }}
        />

        <span aria-hidden="true">
          {/* The server's string, whole. Splitting the "%" off to style it smaller
              would mean React deciding what part of a figure a Trader reads. */}
          <span className="od hero">{card.impliedChance.display}</span>
          <br />
          <span className="lbl">chance</span>
          {gradientLegible ? null : <div className="words">{card.chanceLabel}</div>}
        </span>

        <span aria-hidden="true">
          <span className="k">{card.strike.display}</span>
          <div className="mi">
            {pays}
            <br />
            {card.contracts.display} for {card.premiumUsdc.display}
          </div>
        </span>
      </button>
    </li>
  );
}

export function DeckRow({
  deck,
  selectedRef,
  dealtRef,
  busy,
  onPick,
}: {
  deck: Deck;
  selectedRef: string | null;
  dealtRef: string | null;
  busy: boolean;
  onPick: (cardRef: string) => void;
}) {
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
        {deck.cards.map((card) => (
          <CardTile
            key={card.cardRef}
            card={card}
            direction={deck.direction}
            selected={card.cardRef === selectedRef}
            dealt={card.cardRef === dealtRef}
            gradientLegible={deck.gradientLegible}
            disabled={busy}
            onPick={() => onPick(card.cardRef)}
          />
        ))}
      </ul>
    </div>
  );
}
