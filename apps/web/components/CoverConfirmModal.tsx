"use client";

/**
 * Issue #46 — the door at the end of `/cover`: "Cover this loan", and the confirmation
 * it opens.
 *
 * Opens the SAME SHAPE of confirmation `ConfirmModal`/`RfqModal` already use on the
 * trading surface -- the same scrim, the same focus trap, the same belief statement,
 * the same labelled list -- so a Borrower does not learn a second interface. What
 * differs is what there is to show: a Cover has no premium yet either, only a cap, and
 * ADR-0008 requires a Borrower to be told, in so many words, that a maker still has to
 * bid and that they confirm a second time before anything is signed. That is the four
 * `gate` steps below -- not decoration, the thing that stops "Request cover" reading
 * like "Buy".
 *
 * Every figure here is the server's own `.display` string off the `CoverQuote` the page
 * already fetched. The request this dialog submits carries only the Borrower's address
 * (`requestCoverRfq` in `lib/api.ts`) -- a selector, never a value, exactly like a
 * `cardRef` on the trading surface. The server re-reads the Loan and re-derives
 * everything it answers with, so a stale dialog cannot change what is actually asked.
 *
 * On submit, the belief/list/gate are replaced IN PLACE by the server's own refusal --
 * never a pending state, because nothing here is ever pending: the sealed-bid backend
 * is not built, so the only real answer is the honest 501 (or, for an uncoverable Loan,
 * that Loan's own refusal -- see `requestCoverRfq`'s doc comment). The primary button
 * disappears and the remaining one is relabelled to close, exactly the shape
 * `RfqModal`'s own refusal receipt already settled on.
 */
import { useEffect, useRef } from "react";
import type { CoverQuote } from "../lib/api";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function CoverConfirmModal({
  open,
  quote,
  busy,
  refusal,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** The quote the door was opened from. Only ever null before a first quote exists. */
  quote: CoverQuote | null;
  busy: boolean;
  /** The server's own sentence, shown verbatim once the Borrower has asked. */
  refusal: string | null;
  onSubmit: () => void;
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

  // Done: the server has answered, either way -- the 501 or that Loan's own refusal.
  // Either way the flow is over, so the size of the buttons below collapses to one.
  const done = Boolean(refusal);

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
            <small>Nothing is signed until you confirm</small>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {!done ? (
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
              <dt>Protection ends</dt>
              <dd data-testid="cover-ends">{quote.cover.expiry.display}</dd>
              {/* The oversized figure -- the same weighting Max Loss gets on the trading
                  surface, and for the same reason: the worst case is the thing a
                  Borrower cannot miss. */}
              <dt>Most you can pay</dt>
              <dd className="hero" data-testid="cover-cap">
                {quote.cover.premiumCapUsdc.display}
              </dd>
            </dl>

            {/* The gate: what still has to happen before anything is signed. Stated as
                four steps rather than left implicit, because "Request cover" reading
                like "Buy" is exactly the misunderstanding ADR-0008 exists to prevent. */}
            <ul className="gate" aria-label="What still has to happen">
              <li className="pass">
                <i aria-hidden="true" />
                You ask for the cover
                <span className="sr"> — done</span>
              </li>
              <li className="wait">
                <i aria-hidden="true" />
                Makers bid, sealed, for a short window
                <span className="sr"> — waiting</span>
              </li>
              <li className="wait">
                <i aria-hidden="true" />
                You see the winning price and confirm again
                <span className="sr"> — waiting</span>
              </li>
              <li className="wait">
                <i aria-hidden="true" />
                Only then is anything signed
                <span className="sr"> — waiting</span>
              </li>
            </ul>
          </>
        ) : (
          <p className="refusal" role="alert" data-testid="cover-refusal">
            <span aria-hidden="true">⚠</span>
            {refusal}
          </p>
        )}

        <footer>
          {!done ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={onSubmit}
              data-testid="cover-submit"
            >
              Request cover
            </button>
          ) : null}
          <button type="button" className="btn ghost" onClick={onClose} data-testid="cover-close">
            {done ? "Close" : "Not now"}
          </button>
        </footer>
      </div>
    </>
  );
}
