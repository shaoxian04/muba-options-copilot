/**
 * The Cover price line (issue #44).
 *
 * Three prices on one horizontal axis, ascending left to right, to scale:
 *   - the liquidation price (red dot, left)
 *   - the cover strike / "pays from" (orange dot, middle)
 *   - today's spot price (dark dot, right -- or in the tight scenario, left of strike)
 *
 * The danger band between liquidation and strike is drawn in the put colour (orange),
 * matching the product's call/put palette: blue for calls, orange for puts. Not red/green.
 *
 * Coordinates come from `coverPriceLine` in `lib/geometry.ts`, the only module
 * allowed to do arithmetic in apps/web -- this component only reads `.x` offsets and
 * renders them as inline CSS percentage positions. No arithmetic here, for the same
 * reason `PayoffStrip.tsx` and `DepthChart.tsx` use geometry.ts instead of computing
 * their own coordinates.
 */
import { coverPriceLine } from "../lib/geometry";
import type { CoverQuote } from "@copilot/shared";

interface Props {
  quote: CoverQuote;
}

export function CoverPriceLine({ quote }: Props) {
  const geo = coverPriceLine(
    quote.cover.liquidationPrice.value,
    quote.cover.targetStrike.value,
    quote.spot.value
  );

  return (
    <div className="cvr-line">
      <div className="cvr-line-axis" role="img" aria-label={`Price axis: liquidation at ${quote.cover.liquidationPrice.display}, cover pays from ${quote.cover.targetStrike.display}, ${quote.underlying} now at ${quote.spot.display}`}>
        {/* The danger band: from liquidation to strike, in the put colour */}
        <div
          className="cvr-line-danger"
          style={{ left: `${geo.danger.left}%`, width: `${geo.danger.width}%` }}
        />

        {/* Liquidation price: the price Aave liquidates at */}
        <div className="cvr-line-pt cvr-line-liq" style={{ left: `${geo.liquidation.x}%` }}>
          <span className="cvr-line-k">Sold if</span>
          <i />
          <span className="cvr-line-v num">{quote.cover.liquidationPrice.display}</span>
        </div>

        {/* Cover strike: where the put starts paying */}
        <div className="cvr-line-pt cvr-line-stk" style={{ left: `${geo.strike.x}%` }}>
          <span className="cvr-line-k">Cover pays from</span>
          <i />
          <span className="cvr-line-v num">{quote.cover.targetStrike.display}</span>
        </div>

        {/* Spot price: where the market is right now */}
        <div className="cvr-line-pt cvr-line-now" style={{ left: `${geo.spot.x}%` }}>
          <span className="cvr-line-k">{quote.underlying} now</span>
          <i />
          <span className="cvr-line-v num">{quote.spot.display}</span>
        </div>
      </div>
    </div>
  );
}
