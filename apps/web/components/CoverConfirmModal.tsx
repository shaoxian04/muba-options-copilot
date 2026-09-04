"use client";

/**
 * The door at the end of `/cover`: "Cover this loan", and the confirmation it opens.
 *
 * Opens the SAME SHAPE of confirmation `ConfirmModal`/`RfqModal` already use on the
 * trading surface -- the same scrim, the same focus trap, the same belief statement, the
 * same labelled list -- so a Borrower does not learn a second interface.
 *
 * **The gate is the whole design.** Four steps, stated rather than left implicit, because
 * "Request cover" reading like "Buy" is exactly the misunderstanding ADR-0008 exists to
 * prevent. When this dialog was built the four steps were a promise about a backend that
 * did not exist yet. They now describe what actually happens, and they light up as it
 * does: asked, makers bidding, a real price to confirm, signed. Nothing about the wording
 * had to change -- which is the nicest thing that can be said about the shape it was
 * given first.
 *
 * **A premium appears exactly once**, at step three, and it is a maker's own answer read
 * off `settle.premiumUsdc`. Before that the dialog shows the cap and calls it the cap.
 * There is no interpolation, no estimate, and no "around" -- until an Offer answers, no
 * price exists, and the Borrower is told so in those words.
 *
 * Every figure is the server's own `.display` string. The request this dialog opens
 * carries only the Borrower's address -- a selector, never a value, exactly like a
 * `cardRef` on the trading surface -- so a stale dialog cannot change what is asked.
 */
import { useEffect, useRef } from "react";
import type { PreparedRfqSettle, RfqStatus } from "@copilot/shared";
import type { CoverQuote, FillReceipt } from "../lib/api";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `pass` once it has happened, `wait` until then. Never `fail` -- none of these can fail. */
const step = (done: boolean) => (done ? "pass" : "wait");

export function CoverConfirmModal({
  open,
  quote,
  busy,
  refusal,
  status,
  settle,
  receipt,
  walletReady,
  onSubmit,
  onAccept,
  onWithdraw,
  onClose,
}: {
  open: boolean;
  /** The quote the door was opened from. Only ever null before a first quote exists. */
  quote: CoverQuote | null;
  busy: boolean;
  /** The server's own sentence, shown verbatim whenever something was refused. */
  refusal: string | null;
  /** The live Cover Request, once one exists on-chain. Null while the Borrower is deciding. */
  status: RfqStatus | null;
  /** The prepared second signature, once a maker's price is ready to accept. */
  settle: PreparedRfqSettle | null;
  receipt: FillReceipt | null;
  /** Whether a wallet is connected AND verified as the one that owns this Loan. */
  walletReady: boolean;
  onSubmit: () => void;
  onAccept: () => void;
  onWithdraw: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open || !quote) return null;

  const requested = status !== null;
  const answered = status?.phase === "OFFERED";
  const settled = status?.phase === "SETTLED";
  const unanswered = status?.phase === "NO_OFFERS";
  const withdrawn = status?.phase === "CANCELLED";

  // The premium, once one exists. Read off `settle` in preference to `status` because
  // that is the figure attached to the transaction about to be signed -- what the
  // Borrower confirms and what the chain charges are then the same number.
  const premium = settle?.premiumUsdc ?? status?.premiumUsdc ?? null;

  /**
   * A refusal that ends the flow, as opposed to one the Borrower can act on.
   *
   * A Loan that cannot be covered at all is finished -- there is nothing left to press.
   * A wallet that declined a signature is not: the request may still be sitting on-chain
   * with makers answering it, so the dialog keeps its actions.
   */
  const dead = Boolean(refusal) && !requested;

  return (
    <>
      <div className="scrim" data-testid="cover-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Cover this loan"
        data-testid="cover-confirm-modal"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <div>
            <b>Cover this loan</b>
            <small>{settled ? "Bought" : "Nothing is signed until you confirm"}</small>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {!dead ? (
          <>
            <p className="belief" data-testid="cover-belief">
              If {quote.underlying} falls below <em>{quote.cover.targetStrike.display}</em> before{" "}
              {quote.cover.expiry.display}, this pays you what your collateral loses.
            </p>

            <dl>
              <dt>Protects</dt>
              <dd data-testid="cover-protects">{quote.loan.collateralAmount.display}</dd>
              <dt>Pays you from</dt>
              <dd data-testid="cover-pays-from">{quote.cover.targetStrike.display}</dd>
              <dt>Size</dt>
              <dd data-testid="cover-size">
                {quote.cover.requiredContracts.display} {quote.underlying} puts
              </dd>
              {/*
               * ADR-0016: a Coverage is shown wherever a premium is. The Ask always buys
               * the whole hedge -- the cap binds as a ceiling on price, not on size -- so
               * this reads 100%, and saying so out loud is the point. "Cover" must never
               * be left to imply "fully covered" by default.
               */}
              {status?.ask.coverage ? (
                <>
                  <dt>Covers</dt>
                  <dd data-testid="cover-coverage">{status.ask.coverage.display} of this loan</dd>
                </>
              ) : null}
              <dt>Protection ends</dt>
              <dd data-testid="cover-ends">{quote.cover.expiry.display}</dd>
              {/*
               * The oversized figure -- the same weighting Max Loss gets on the trading
               * surface, and for the same reason: the worst case is the thing a Borrower
               * cannot miss. Once a maker has answered it becomes the real price, because
               * at that point the worst case IS the price.
               */}
              <dt>{premium ? "You pay" : "Most you can pay"}</dt>
              <dd className="hero" data-testid="cover-cap">
                {premium ? premium.display : quote.cover.premiumCapUsdc.display}
              </dd>
            </dl>

            {/*
             * The gate. Live now: each step turns from dashed to solid as the request
             * actually reaches it, so a Borrower watching this dialog can see where they
             * are rather than being told where they will be.
             */}
            <ul className="gate" aria-label="What still has to happen" data-testid="cover-gate">
              <li className={step(requested)}>
                <i aria-hidden="true" />
                You ask for the cover
                <span className="sr">{requested ? " — done" : " — waiting"}</span>
              </li>
              <li className={step(answered || settled)}>
                <i aria-hidden="true" />
                Makers bid, sealed, for a short window
                <span className="sr">{answered || settled ? " — done" : " — waiting"}</span>
              </li>
              <li className={step(settled)}>
                <i aria-hidden="true" />
                You see the winning price and confirm again
                <span className="sr">{settled ? " — done" : " — waiting"}</span>
              </li>
              <li className={step(settled)}>
                <i aria-hidden="true" />
                Only then is anything signed
                <span className="sr">{settled ? " — done" : " — waiting"}</span>
              </li>
            </ul>

            {/*
             * The server's own sentence for wherever the request has got to. `role=
             * "status"` is a POLITE live region: a maker answering is news, not an
             * emergency, so it announces once assistive technology is ready rather than
             * interrupting -- the same choice the REFUSED block on the page itself makes.
             */}
            {status ? (
              <div
                className={`receipt${settled ? " ok" : ""}`}
                role="status"
                data-testid="cover-wait"
                data-phase={status.phase}
              >
                <p data-testid="cover-wait-sentence">{status.sentence}</p>
                {status.phase === "OPEN" || answered ? (
                  <p className="mnote" data-testid="cover-offer-count">
                    {status.offers.display} answered so far · offers close {status.ask.offersCloseAt.display}
                  </p>
                ) : null}
              </div>
            ) : null}

            {receipt?.explorerUrl ? (
              <div className="receipt ok" data-testid="cover-receipt">
                <b>transaction</b>
                <a href={receipt.explorerUrl} target="_blank" rel="noreferrer">
                  View on Basescan
                </a>
              </div>
            ) : null}

            {refusal ? (
              <p className="refusal" role="alert" data-testid="cover-refusal">
                <span aria-hidden="true">⚠</span>
                {refusal}
              </p>
            ) : null}

            {!walletReady && !requested ? (
              <p className="mnote" data-testid="cover-gate-wallet">
                Connect and verify the wallet that holds this loan first. A cover pays whoever holds it, so it
                has to be bought by the same wallet — otherwise it would protect someone else.
              </p>
            ) : null}
          </>
        ) : (
          <p className="refusal" role="alert" data-testid="cover-refusal">
            <span aria-hidden="true">⚠</span>
            {refusal}
          </p>
        )}

        <footer>
          {/*
           * One primary action at a time, and which one it is says where the flow is. The
           * button that spends money names the amount, so nobody presses it without
           * having read the price.
           */}
          {dead || settled || withdrawn ? null : answered ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={onAccept}
              data-testid="cover-accept"
            >
              {busy ? "Paying…" : `Pay ${premium ? premium.display : "the offer"}`}
            </button>
          ) : requested ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={onWithdraw}
              data-testid="cover-withdraw"
            >
              {unanswered ? "Withdraw request" : "Withdraw"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={busy || !walletReady}
              onClick={onSubmit}
              data-testid="cover-submit"
            >
              {busy ? "Requesting…" : "Request cover"}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose} data-testid="cover-close">
            {dead || settled || withdrawn ? "Close" : "Not now"}
          </button>
        </footer>
      </div>
    </>
  );
}
