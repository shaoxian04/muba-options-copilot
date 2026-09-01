"use client";

/**
 * The ticker rail: every market that is quoting, and which one the Trader is looking at.
 *
 * The picker is the SOURCE OF TRUTH for the selected Underlying. Saying "buy me some
 * SOL" in the Copilot panel must not move it -- reading an asset name out of a sentence
 * is the Trade Agent's job and that service does not exist yet (ADR-0007). A regex here
 * that guessed would be a model originating a selection.
 *
 * Every figure arrives pre-formatted. The only arithmetic on this page is the split
 * bar's two widths, and even those are not computed here: the server ships `callShare`
 * as a proportion and `lib/geometry.ts` -- the module allowed to make coordinates --
 * turns it into a percentage.
 */
import type { MarketRow, UnderlyingSymbol } from "@copilot/shared";
import { sharePercent } from "../lib/geometry";

/**
 * Each Underlying's own colour, used only for its mark.
 *
 * Deliberately NOT the call/put pair: these are identity, not meaning. A Trader picks
 * BTC out of the rail by its orange circle, and nothing about that circle claims
 * anything is rising or falling. The two-segment bar below it is where blue and orange
 * carry meaning, and those come from `--call` / `--put` in the stylesheet, where the
 * colour measurement can reach them.
 */
const BRAND: Record<string, string> = {
  ETH: "#627EEA",
  BTC: "#F7931A",
  SOL: "#14F195",
  BNB: "#F3BA2F",
  XRP: "#7B8794",
  AVAX: "#E84142",
};

/** A single character for the four cash-settled Underlyings, which have no glyph. */
const GLYPH: Record<string, string> = { SOL: "◎", BNB: "◆", XRP: "✕", AVAX: "▲" };

/**
 * A recognisable circular mark.
 *
 * A real glyph for ETH and BTC because those two are recognised on sight, and a single
 * character on the brand colour for the rest. Decorative: `aria-hidden`, because the
 * symbol is right beside it in text and a screen reader announcing both would read
 * every row twice.
 */
function Mark({ symbol, size = 26 }: { symbol: string; size?: number }) {
  const r = size / 2;
  const fill = BRAND[symbol] ?? "#7B8794";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="mk">
      <circle cx={r} cy={r} r={r} fill={fill} />
      {symbol === "ETH" ? (
        <g transform={`translate(${r},${r}) scale(${size / 34})`} fill="#fff">
          <path d="M0 -12 L7.2 0.3 L0 4.6 L-7.2 0.3 Z" opacity=".95" />
          <path d="M0 6.1 L7.2 1.8 L0 12 L-7.2 1.8 Z" opacity=".6" />
        </g>
      ) : (
        <text
          x={r}
          y={r + size * (symbol === "BTC" ? 0.235 : 0.2)}
          textAnchor="middle"
          fill={symbol === "BTC" ? "#fff" : "#0A0E14"}
          fontWeight="700"
          fontSize={size * (symbol === "BTC" ? 0.66 : 0.54)}
        >
          {symbol === "BTC" ? "₿" : (GLYPH[symbol] ?? symbol.slice(0, 1))}
        </text>
      )}
    </svg>
  );
}

export function Rail({
  markets,
  asset,
  onPick,
}: {
  markets: MarketRow[];
  asset: UnderlyingSymbol;
  onPick: (symbol: UnderlyingSymbol) => void;
}) {
  return (
    <div className="rail-top" role="group" aria-label="Which market to trade">
      {markets.map((m) => {
        const selected = m.symbol === asset;
        return (
          <button
            key={m.symbol}
            type="button"
            className="trow"
            // Selection is carried by aria-pressed, so it reaches a screen reader as a
            // state rather than as a background colour it cannot see.
            aria-pressed={selected}
            onClick={() => onPick(m.symbol)}
            data-testid={`rail-${m.symbol}`}
          >
            <Mark symbol={m.symbol} />
            <b>{m.symbol}</b>
            <span className="num">{m.spotUsd ? m.spotUsd.display : "—"}</span>

            {/*
              The split of Maker Depth, so a one-sided market is visible without reading
              a number -- and several of these markets are one-sided. Blue is calls,
              orange is puts; never green and red, which separate by dE 5.5 under
              deuteranopia against a bar of 8 (see tests/support/ramp.test.ts).

              The bar is decoration over the sentence below it, which is what actually
              carries this to a screen reader.
            */}
            <span className="sp" aria-hidden="true">
              <i style={{ width: sharePercent(m.callShare), background: "var(--call)" }} />
              <i style={{ width: sharePercent(1 - m.callShare), background: "var(--put)" }} />
            </span>

            <span className="sr">
              {m.name}
              {m.spotUsd ? `, ${m.spotUsd.display}` : ", price unavailable"}
              {`. Maker Depth ${m.callDepthUsdc.display} on rises, ${m.putDepthUsdc.display} on falls.`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
