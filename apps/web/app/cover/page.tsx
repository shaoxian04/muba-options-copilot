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
 *   4. The door only ever opens on a click, and NOTHING is signed without one. Reading a
 *      Loan touches only `GET /cover/quote`. `POST /rfq` is reached from the
 *      confirmation's own "Request cover" button and nowhere else, and the second
 *      signature -- the one that actually pays -- needs its own separate press on a
 *      button that names the price. No unattended renewal, ever. (ADR-0008, ADR-0017)
 *   4b. A Cover is bought by the wallet that holds the Loan, and only that wallet. A put
 *      pays whoever holds it, so a Cover bought for someone else's Loan protects the
 *      buyer and leaves the Borrower exactly as exposed as before. The page can READ any
 *      address; it can only BUY for the one this session has proven.
 *   5. Not one number was computed here. Every figure arrives as `{ value, display }`
 *      and the JSX renders `display` verbatim. `no-arithmetic.test.ts` fails the build
 *      over a `toFixed` or a literal dollar sign. (ADR-0006)
 */
import { useEffect, useRef, useState } from "react";
import type { PreparedRfqSettle, RfqStatus } from "@copilot/shared";
import {
  ApiRefusal,
  cancelRfq,
  confirmRfq,
  getCoverQuote,
  getRfqStatus,
  isCoverRefusal,
  prepareRfqCancel,
  prepareRfqSettle,
  requestCoverRfq,
  settleRfq,
  type CoverQuoteResult,
  type FillReceipt,
} from "../../lib/api";
import { RFQ_POLL_MS } from "../../lib/surface";
import { useWallet } from "../../lib/useWallet";
import { sendTx } from "../../lib/wallet";
import { CoverPriceLine } from "../../components/CoverPriceLine";
import { CoverConfirmModal } from "../../components/CoverConfirmModal";
import { WalletConnect } from "../../components/WalletConnect";

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

  // The live Cover Request (ADR-0017). Null until the Borrower has actually opened one.
  const [coverStatus, setCoverStatus] = useState<RfqStatus | null>(null);
  const [coverSettle, setCoverSettle] = useState<PreparedRfqSettle | null>(null);
  const [coverReceipt, setCoverReceipt] = useState<FillReceipt | null>(null);
  /**
   * The request id, in a ref rather than state: the polling effect reads it, and putting
   * it in state would restart the poll on every tick that touched it. Nothing renders it.
   */
  const requestIdRef = useRef<string | null>(null);

  const wallet = useWallet();

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

  /**
   * Dismissing the dialog forgets the request on THIS screen; it does not withdraw it.
   * A request stays live on-chain until it is settled, withdrawn or expires, and the Risk
   * Budget goes on holding its Reserve Price -- which is the truth, and the opposite of
   * what quietly clearing it here would imply.
   */
  function closeDoor() {
    setDoorOpen(false);
    setCoverStatus(null);
    setCoverSettle(null);
    setCoverReceipt(null);
    requestIdRef.current = null;
    doorOpenerRef.current?.focus();
  }

  /**
   * Whether this session may BUY for the address it is looking at.
   *
   * Reading is open to anyone -- a Borrower who learns their liquidation price and walks
   * away has been served, and that has never needed a wallet. Buying is not: the put pays
   * whoever holds it, so the wallet opening the request has to be the wallet that holds
   * the Loan, or the Cover protects the wrong person. The backend refuses this too; the
   * page checks so it can say why before a press rather than after one.
   */
  const walletOwnsLoan =
    Boolean(wallet.address) &&
    wallet.verified &&
    Boolean(quote) &&
    wallet.address!.toLowerCase() === quote!.address.toLowerCase();

  /**
   * Poll the open request while makers can still answer.
   *
   * Stops the moment there is nothing left to learn -- bought, withdrawn, or nobody
   * answered -- rather than running forever behind a dialog nobody is watching.
   */
  useEffect(() => {
    const requestId = requestIdRef.current;
    if (!requestId || !coverStatus) return;
    if (coverStatus.phase === "SETTLED" || coverStatus.phase === "CANCELLED" || coverStatus.phase === "NO_OFFERS")
      return;

    const controller = new AbortController();
    const timer = setInterval(() => {
      void getRfqStatus(requestId, controller.signal)
        .then(setCoverStatus)
        // A failed poll is just a poll: the next one tries again. Turning a blip into a
        // refusal would tell a Borrower something is wrong while their request sits
        // on-chain doing exactly what it should.
        .catch(() => {});
    }, RFQ_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [coverStatus]);

  /**
   * The FIRST of two signatures: open the Cover Request on-chain.
   *
   * Carries only the Borrower's address -- the server re-reads the Loan and re-derives
   * strike, size and cap itself, so nothing typed or tampered with in the browser can
   * change what is actually requested. Nothing is bought here: an RFQ has no price until
   * a maker answers, and what is committed to is the Reserve Price ceiling.
   */
  async function submitCover() {
    if (!quote) return;
    setDoorBusy(true);
    setDoorRefusal(null);
    let requestId: string | null = null;
    try {
      const res = await requestCoverRfq({ address: quote.address });
      // An uncoverable Loan answers 200 with its own refusal rather than a prepared
      // request. Being told "this Loan holds two assets" is an answer, not a failure.
      if (isCoverRefusal(res)) {
        setDoorRefusal(res.refusal.message);
        return;
      }

      requestId = res.requestId;
      const txHash = await sendTx(res.requestTx);
      const confirmed = await confirmRfq(res.requestId, txHash);
      if (!confirmed.opened || !confirmed.status) {
        setDoorRefusal("The request did not open on-chain. No USDC moved. You can try again.");
        return;
      }
      requestIdRef.current = res.requestId;
      setCoverStatus(confirmed.status);
    } catch (err) {
      // Only report a decline if a request was actually prepared -- `/rfq` holds the
      // Reserve Price against the Risk Budget synchronously the moment it runs, so an
      // abandoned request has to be released rather than left sitting on the ceiling.
      if (requestId) await confirmRfq(requestId).catch(() => {});
      setDoorRefusal(
        err instanceof ApiRefusal ? err.message : "Could not reach the backend. Is it running on :3001?"
      );
    } finally {
      setDoorBusy(false);
    }
  }

  /**
   * The SECOND signature: accept a maker's own price and pay it.
   *
   * The premium the dialog shows is the exact amount encoded into the transaction being
   * signed, so what the Borrower confirms and what the chain charges cannot differ. This
   * is the human confirmation ADR-0008 requires, and it is a separate press on a button
   * that names the amount -- never a continuation of the first one.
   */
  async function acceptCover() {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    setDoorBusy(true);
    setDoorRefusal(null);
    let prepared: PreparedRfqSettle | null = null;
    try {
      prepared = await prepareRfqSettle(requestId);
      setCoverSettle(prepared);
      if (prepared.approveTx) await sendTx(prepared.approveTx);
      const txHash = await sendTx(prepared.settleTx);

      // The wallet has broadcast and mined this -- the money has moved. Everything from
      // here is bookkeeping, so a failure to reach /rfq/settle must never be reported as
      // a Cover that was not bought.
      const done = await settleRfq(requestId, txHash).catch(() => null);
      if (done) setCoverStatus(done.status);
      setCoverReceipt({
        txHash,
        optionAddress: done?.status.optionAddress ?? "",
        explorerUrl: `${prepared.explorerTxUrlBase}${txHash}`,
      });
    } catch (err) {
      if (prepared) await settleRfq(requestId, undefined).catch(() => {});
      setDoorRefusal(
        err instanceof ApiRefusal ? err.message : "The wallet could not complete this purchase."
      );
    } finally {
      setDoorBusy(false);
    }
  }

  /** Withdraw a request nobody answered, taking the commitment to pay back off the chain. */
  async function withdrawCover() {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    setDoorBusy(true);
    setDoorRefusal(null);
    try {
      const prepared = await prepareRfqCancel(requestId);
      const txHash = await sendTx(prepared.cancelTx);
      await cancelRfq(requestId, txHash).catch(() => {});
      const status = await getRfqStatus(requestId).catch(() => null);
      if (status) setCoverStatus(status);
    } catch (err) {
      setDoorRefusal(
        err instanceof ApiRefusal ? err.message : "The wallet could not withdraw this request."
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
         * The wallet, beside the form rather than inside the dialog.
         *
         * Reading a Loan never needs one -- any address can be typed and read, and that
         * has to keep working, because a Borrower who learns their liquidation price and
         * walks away has been served. Connecting is what makes BUYING possible later, so
         * it sits here where there is time to do it, not as a surprise gate discovered
         * halfway through a confirmation.
         */}
        <div className="cvr-wallet">
          <WalletConnect
            address={wallet.address}
            connecting={wallet.connecting}
            verified={wallet.verified}
            verifying={wallet.verifying}
            error={wallet.error}
            onConnect={() => void wallet.connect()}
            onVerify={() => void wallet.verify()}
          />
          {wallet.address && wallet.address.toLowerCase() !== address.trim().toLowerCase() ? (
            <button
              type="button"
              className="cvr-usemine"
              onClick={() => setAddress(wallet.address!)}
              data-testid="cover-use-my-wallet"
            >
              Read my own loan
            </button>
          ) : null}
        </div>

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
                  {/*
                    * "covers the loan in full" describes the SIZE asked for, which is
                    * always the whole hedge (ADR-0016). It is the price that is capped,
                    * not the size -- so the sentence is true of what is requested, and
                    * the request either gets answered at that size or not at all.
                    */}
                  <SheetRow
                    term="Size"
                    value={quote.cover.requiredContracts.display}
                    qualifier={`${quote.underlying} puts — the whole hedge this loan needs`}
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
              <span className="note">
                {walletOwnsLoan
                  ? "You will see exactly what you are agreeing to first, and again before you pay."
                  : "You will see exactly what you are agreeing to first. Connect this wallet above to buy."}
              </span>
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
        status={coverStatus}
        settle={coverSettle}
        receipt={coverReceipt}
        walletReady={walletOwnsLoan}
        onSubmit={submitCover}
        onAccept={acceptCover}
        onWithdraw={withdrawCover}
        onClose={closeDoor}
      />
    </>
  );
}
