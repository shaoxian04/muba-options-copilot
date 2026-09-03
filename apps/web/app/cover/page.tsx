"use client";

/**
 * Liquidation Cover — the main surface (issues #44-#46, variant B).
 *
 * A different context from the trading surface (CONTEXT-MAP.md), and it reads as one:
 * no Deck, no ticker rail, no call/put palette. The vocabulary here is Borrower, Loan,
 * Cover and Lapse -- if the word "Position" appears on this page it is wrong.
 *
 * Five things this page is built around, in order:
 *
 *   1. The answer comes BEFORE the data. The verdict card (health factor, the sentence,
 *      today's price) leads -- not a wall of Aave numbers.
 *   2. The LAPSE is prominent. A lapsed Cover is worse than no Cover, because the
 *      Borrower believes they are protected and stops watching. (ADR-0008)
 *   3. A REFUSAL is an answer, not an error -- laid out as content, with the code as a
 *      label, never as a toast. A transport failure or a 4xx is a different, louder
 *      thing (`.cvr-alert`, `role="alert"`). (Issue #45)
 *   4. The door only ever opens on a click. Reading a Loan touches only
 *      `GET /cover/quote`; `POST /rfq` is reached exactly once, from the confirmation's
 *      own "Request cover" button, and nowhere else on this page. (Issue #46; ADR-0008)
 *   5. Not one number was computed here. Every figure arrives as `{ value, display }`
 *      and the JSX renders `display` verbatim. `no-arithmetic.test.ts` fails the build
 *      over a `toFixed` or a literal dollar sign. (ADR-0006)
 */
import { useRef, useState } from "react";
import { ApiRefusal, getCoverQuote, requestCoverRfq, type CoverQuoteResult } from "../../lib/api";
import { CoverPriceLine } from "../../components/CoverPriceLine";
import { CoverConfirmModal } from "../../components/CoverConfirmModal";

/**
 * One row in a "sheet" dl: a labelled value with an optional qualifier underneath.
 *
 * The qualifier carries the context that makes the value interpretable: "worth $3,668",
 * "Aave's price, not ours", "covers the loan in full". A value without its qualifier
 * is half a sentence.
 */
function SheetRow({ term, value, qualifier }: { term: string; value: string; qualifier?: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>
        {value}
        {qualifier ? <span className="q">{qualifier}</span> : null}
      </dd>
    </>
  );
}

export default function CoverPage() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<CoverQuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The door (issue #46). `doorRefusal` is null until the Borrower has actually
  // pressed "Request cover" inside the dialog -- opening the dialog itself never
  // touches the network, so there is no request to /rfq on page load or on reading
  // a Loan, only on that one explicit press.
  const [doorOpen, setDoorOpen] = useState(false);
  const [doorBusy, setDoorBusy] = useState(false);
  const [doorRefusal, setDoorRefusal] = useState<string | null>(null);
  const doorOpenerRef = useRef<HTMLElement | null>(null);

  async function read(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await getCoverQuote({ address: address.trim() }));
    } catch (err) {
      // Only a transport or a 4xx lands here. A REFUSED Cover arrives as a normal 200
      // and is rendered as content -- pushing "this Loan holds two assets" into an
      // error boundary would turn a true sentence into a broken app.
      setError(
        err instanceof ApiRefusal ? err.message : "Could not reach the backend. Is it running on :3001?"
      );
    } finally {
      setBusy(false);
    }
  }

  const quote = result?.status === "QUOTE" ? result.quote : null;

  /** Opens the door. Captured here, before the click, for focus to return to on close. */
  function openDoor(e: React.MouseEvent<HTMLButtonElement>) {
    doorOpenerRef.current = e.currentTarget;
    setDoorRefusal(null);
    setDoorBusy(false);
    setDoorOpen(true);
  }

  function closeDoor() {
    setDoorOpen(false);
    doorOpenerRef.current?.focus();
  }

  /**
   * The one place this page ever reaches `/rfq`. Carries only the Borrower's address
   * (`requestCoverRfq`) -- the server re-reads the Loan and re-derives strike, size
   * and cap itself, so nothing typed or tampered with in the browser can change what
   * is actually requested. Never a pending state: the answer is always immediate,
   * either the honest 501 or that Loan's own refusal (see `requestCoverRfq`'s own
   * doc comment in `lib/api.ts`).
   */
  async function submitCover() {
    if (!quote) return;
    setDoorBusy(true);
    try {
      const res = await requestCoverRfq({ address: quote.address });
      setDoorRefusal(res.refusal.message);
    } catch (err) {
      setDoorRefusal(
        err instanceof ApiRefusal ? err.message : "Could not reach the backend. Is it running on :3001?"
      );
    } finally {
      setDoorBusy(false);
    }
  }

  return (
    <>
      <main className="cvr">
        {/* Heading and one-line introduction */}
        <h1>Liquidation Cover</h1>
        <p className="sub">
          See what protects your Aave loan if the market falls. Nothing is bought until you say so.
        </p>

        {/* Address form */}
        <form className="ask" onSubmit={read}>
          <div className="fld">
            <label htmlFor="addr">Wallet address</label>
            <input
              id="addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="go" disabled={busy || address.trim().length === 0}>
            {busy ? "Reading…" : "Read loan"}
          </button>
        </form>

        {/*
         * A transport failure or a 4xx: something actually went wrong, and it is a
         * different thing from a REFUSED answer below -- louder, and visibly distinct.
         * `role="alert"` is an implicit assertive live region, interrupting the way an
         * error genuinely should; `.cvr-alert` carries the crit-red accent no REFUSED
         * block ever uses, so the two are told apart at a glance and not just by reading.
         */}
        {error ? (
          <div className="cvr-alert" role="alert">
            <h2>Something went wrong</h2>
            <p>{error}</p>
          </div>
        ) : null}

        {/*
         * A REFUSED result is a normal 200 -- the Borrower asked a question and got a
         * true one -- so it is laid out as content, never as an error boundary or a
         * toast. `role="status"` is an implicit POLITE live region: it announces once
         * assistive technology is ready to listen, without interrupting the way an
         * `alert` does, matching the fact that nothing here is actually broken. The
         * refusal code renders as a plain label underneath -- a Borrower reads the
         * sentence; the code is there for support conversations and bug reports.
         *
         * No "Cover this loan" door appears anywhere near this block: the door only
         * ever renders inside the `quote` branch below, so a Loan that cannot be
         * quoted has nothing to press.
         */}
        {result?.status === "REFUSED" ? (
          <div className="cvr-declined" role="status">
            <h2>We can’t cover this loan</h2>
            <p>{result.refusal.message}</p>
            <div className="cvr-declined-code">
              <span className="lbl">{result.refusal.code.replace(/_/g, " ")}</span>
            </div>
          </div>
        ) : null}

        {quote ? (
          <>
            {/* Verdict card: health factor first, then what it means, then today's price */}
            <div className="verdict">
              <div className="big">
                <span className="lbl">Health factor</span>
                <span className="v hero">{quote.loan.healthFactor.display}</span>
              </div>
              <p className="say">
                If {quote.underlying} falls to <b>{quote.cover.liquidationPrice.display}</b>, Aave
                sells your collateral to repay the loan. A cover pays you back from{" "}
                <b>{quote.cover.targetStrike.display}</b> — before that happens.
              </p>
              <div className="chip">
                <span className="lbl">{quote.underlying} right now</span>
                <span className="v num">{quote.spot.display}</span>
              </div>
            </div>

            {/* Price line: liquidation, cover strike and spot on one axis, to scale */}
            <CoverPriceLine quote={quote} />

            {/* Cost card */}
            <div className="cost">
              <div className="amt">
                <span className="lbl">What it costs</span>
                <span className="v num">{quote.cover.premiumCapUsdc.display}</span>
              </div>
              <div className="txt">
                <p>
                  That is the <b>most</b> you can pay. The exact price is set when a market maker
                  answers your request — you approve it before anything is signed.
                </p>
                <p>
                  It is also the most you can <b>lose</b>: a put can expire worth nothing, but it
                  can never cost you more than you paid for it.
                </p>
              </div>
            </div>

            {/* Lapse strip: expiry, prominent, with the no-auto-renewal sentence */}
            <div className="lapse">
              <span className="lbl">Protection ends</span>
              <b className="v num">{quote.cover.expiry.display}</b>
              <p>
                After this the loan is uncovered again. Nothing renews on its own — renewing
                without you would mean signing without you.
              </p>
            </div>

            {/* Two sheets: Your loan + The cover */}
            <div className="sheets">
              <div className="sheet">
                <div className="cap">
                  <span className="lbl">Your loan</span>
                </div>
                <dl>
                  <SheetRow
                    term="What you put in"
                    value={quote.loan.collateralAmount.display}
                    qualifier={`worth ${quote.loan.collateralUsd.display}`}
                  />
                  <SheetRow term="What you borrowed" value={quote.loan.debtUsd.display} />
                  <SheetRow
                    term={`Sold if ${quote.underlying} hits`}
                    value={quote.cover.liquidationPrice.display}
                    qualifier="Aave's price, not ours"
                  />
                </dl>
              </div>

              <div className="sheet">
                <div className="cap">
                  <span className="lbl">The cover</span>
                </div>
                <dl>
                  <SheetRow
                    term={`${quote.underlying} price now`}
                    value={quote.spot.display}
                    qualifier="Aave's oracle"
                  />
                  <SheetRow
                    term="Pays you from"
                    value={quote.cover.targetStrike.display}
                    qualifier={`${quote.cover.strikeDistanceFromSpot.display} from today`}
                  />
                  <SheetRow
                    term="Size"
                    value={quote.cover.requiredContracts.display}
                    qualifier={`${quote.underlying} puts — covers the loan in full`}
                  />
                </dl>
              </div>
            </div>

            {/*
             * The door (issue #46). A primary button and nothing more urgent-looking --
             * the confirmation it opens is where the actual weight of the decision (the
             * cap, the gate) lives, not this button's own styling.
             */}
            <div className="cta">
              <button type="button" className="go2" onClick={openDoor} data-testid="cover-door">
                Cover this loan
              </button>
              <span className="note">You will see exactly what you are agreeing to first.</span>
            </div>

            {/* Disclosure: the raw Aave numbers, folded away by default */}
            <details className="cvr-disclosure">
              <summary>The Aave numbers this came from</summary>
              <dl>
                <dt>Address</dt>
                <dd>{quote.address}</dd>
                <dt>Liquidation threshold</dt>
                <dd>{quote.loan.liquidationThreshold.display}</dd>
                <dt>Collateral value</dt>
                <dd>{quote.loan.collateralUsd.display}</dd>
                <dt>Health factor</dt>
                <dd>{quote.loan.healthFactor.display}</dd>
                <dt>How long the cover lasts</dt>
                <dd>{quote.cover.tenorDays.display}</dd>
              </dl>
            </details>

            {/* Warnings: alongside the quote, never replacing it (e.g. far-strike scenario) */}
            {quote.warnings.map((w) => (
              <div className="cvr-warn" key={w} role="status">
                {w}
              </div>
            ))}

            {/* Server's disclaimer, verbatim */}
            <p className="disclaimer">{quote.disclaimer}</p>
          </>
        ) : null}
      </main>

      <CoverConfirmModal
        open={doorOpen}
        quote={quote}
        busy={doorBusy}
        refusal={doorRefusal}
        onSubmit={submitCover}
        onClose={closeDoor}
      />
    </>
  );
}
