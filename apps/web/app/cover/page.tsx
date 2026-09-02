"use client";

/**
 * Liquidation Cover.
 *
 * A different context from the trading surface (CONTEXT-MAP.md), and it reads as one: no
 * Deck, no ticker rail, no call/put palette. The vocabulary here is Borrower, Loan, Cover
 * and Lapse -- if the word "position" appears on this page it is wrong.
 *
 * Three things this page is built around, in order:
 *
 *   1. The LAPSE is the loudest thing on it. A lapsed Cover is worse than no Cover,
 *      because the Borrower believes they are protected and stops watching. (ADR-0008)
 *   2. A REFUSAL is an answer, not an error. Of the 40 largest aWETH holders on Base,
 *      30 cannot be quoted -- multi-collateral, no debt, or collateral we will not hedge.
 *      Being told why is the most common thing this page does, so it is laid out as
 *      content rather than as a toast.
 *   3. Not one number on this page was computed here. Every figure arrives as
 *      `{ value, display }` and the JSX renders `display` verbatim; `no-arithmetic.test.ts`
 *      fails the build over a `toFixed` or a literal dollar sign. (ADR-0006)
 */
import { useState } from "react";
import { ApiRefusal, getCoverQuote, type CoverQuoteResult } from "../../lib/api";

/** One row of a panel. `note` carries the qualifier a figure needs to be read correctly. */
function Row({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>
        {value}
        {note ? <span className="qual">{note}</span> : null}
      </dd>
    </>
  );
}

export default function CoverPage() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<CoverQuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function read(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await getCoverQuote({ address: address.trim() }));
    } catch (err) {
      // Only a transport or a 4xx lands here. A REFUSED Cover arrives as a normal answer
      // and is rendered as one -- pushing "this Loan holds two assets" into an error
      // boundary would turn a true sentence into a broken app.
      setError(err instanceof ApiRefusal ? err.message : "Could not reach the backend. Is it running on :3001?");
    } finally {
      setBusy(false);
    }
  }

  const quote = result?.status === "QUOTE" ? result.quote : null;

  return (
    <main className="cvr">
      <h1>Liquidation Cover</h1>
      <p className="sub">
        Read an Aave V3 Loan on Base and see the put option that would protect it against
        liquidation. This page requests nothing from a maker, signs nothing, and spends nothing.
      </p>

      <form onSubmit={read}>
        <div className="fld">
          <label htmlFor="addr">Aave address on Base</label>
          <input
            id="addr"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            aria-describedby="addr-hint"
          />
        </div>
        <button type="submit" disabled={busy || address.trim().length === 0}>
          {busy ? "Reading…" : "Read Loan"}
        </button>
      </form>
      <p id="addr-hint" className="sr">
        Any address may be read. Buying a Cover is only possible for the wallet this backend holds.
      </p>

      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}

      {result?.status === "REFUSED" ? (
        <div className="declined" role="status">
          <h2>No Cover can be priced for this Loan</h2>
          <p>{result.refusal.message}</p>
        </div>
      ) : null}

      {quote ? (
        <>
          {/* The Lapse, first and largest. Everything below it is only true until this date. */}
          <div className="lapse">
            <div className="k">This Cover would lapse on</div>
            <div className="v">{quote.cover.expiry.display}</div>
            <p>
              After that moment the Loan is unprotected again. There is no automatic renewal and
              there never will be — renewing without you would mean signing without you.
            </p>
          </div>

          <div className="panels">
            <section className="panel" aria-label="The Loan">
              <h2>The Loan</h2>
              <dl>
                <Row term="Collateral" value={quote.loan.collateralAmount.display} note={quote.loan.collateralUsd.display} />
                <Row term="Debt" value={quote.loan.debtUsd.display} />
                <Row term="Liquidation threshold" value={quote.loan.liquidationThreshold.display} />
                <Row term="Health factor" value={quote.loan.healthFactor.display} note="liquidatable below 1.00" />
                <Row term={`${quote.collateral} price`} value={quote.spot.display} note="Aave's oracle — the one that liquidates" />
              </dl>
            </section>

            <section className="panel" aria-label="The Cover">
              <h2>The Cover</h2>
              <dl>
                <Row term="Liquidation price" value={quote.cover.liquidationPrice.display} />
                <Row
                  term="Target strike"
                  value={quote.cover.targetStrike.display}
                  note={`${quote.cover.strikeDistanceFromSpot.display} from spot`}
                />
                <Row term="Tenor" value={quote.cover.tenorDays.display} />
                <Row
                  term="Full hedge"
                  value={quote.cover.requiredContracts.display}
                  note={`${quote.underlying} put contracts`}
                />
                <Row term="Most you would pay" value={quote.cover.premiumCapUsdc.display} note="hard cap on the premium" />
              </dl>
            </section>
          </div>

          {quote.warnings.map((w) => (
            <p className="warn" key={w} role="status">
              {w}
            </p>
          ))}

          <p className="disclaimer">{quote.disclaimer}</p>
        </>
      ) : null}
    </main>
  );
}
