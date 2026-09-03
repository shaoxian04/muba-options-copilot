"use client";

/**
 * The RFQ door's dialog: naming a strike the book does not offer, and buying it.
 *
 * Opens the SAME SHAPE of confirmation `ConfirmModal` does -- the same scrim, the same
 * focus trap, the same belief statement, the same labelled list -- so a Trader does not
 * have to learn a second interface for the rarer thing.
 *
 * What differs is that this dialog has THREE states rather than one, because an RFQ is
 * not a Fill (ADR-0017):
 *
 *   1. **Asking.** Controls live, no price anywhere, because none exists. The size is
 *      labelled the Reserve Price and the Max Loss, which is what it actually is.
 *   2. **Waiting.** The request is on-chain and makers can answer until a deadline the
 *      protocol set. The controls freeze -- what was signed cannot be edited -- and the
 *      dialog shows the Ask back, the clock, and how many have answered.
 *   3. **Answered.** A real premium exists, read off a maker's own bid. This is the
 *      second confirmation, and it is the first moment in the whole flow that a price is
 *      shown at all.
 *
 * The habit dropped from `prototype-deck-v2.html`'s `rfqModal`/`strikeControl` still
 * holds: the prototype computed a dollar strike ON THE PAGE as the slider dragged
 * (`dragStrike` called `usd(spot * (1 + pct/100))` in the browser). Until a request is
 * opened, the slider and the belief sentence speak only in the percentage terms the
 * slider itself uses. From the moment there IS a request, the dollar strike is read off
 * `status.ask.strike.display` -- a string the server derived and the browser renders
 * verbatim, which is the only way a figure is ever allowed to appear here. (ADR-0006)
 *
 * No `quoteMoved`, still deliberately (issue #32). `quoteMoved` compares the premium a
 * Trader was SHOWN against what the next Deck poll answers; here there is no premium to
 * move until a maker answers, and once one has, the amount is baked into the transaction
 * being signed rather than re-fetched.
 */
import { useEffect, useRef, useState } from "react";
import type { Figure, PreparedRfqSettle, RfqStatus, RfqTenorDays, UnderlyingSymbol } from "@copilot/shared";
import { riskBudgetBar, rfqSizeCapUsdc } from "../lib/geometry";
import {
  RFQ_STRIKE_BAND_PCT,
  RFQ_STRIKE_STEP_PCT,
  RFQ_TENOR_DAYS,
  SIZE_MIN_USDC,
  SIZE_PRESETS_USDC,
  type Direction,
} from "../lib/surface";
import type { FillReceipt, SessionState } from "../lib/api";
import { Mark } from "./Rail";
import { WalletConnect } from "./WalletConnect";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dollar string for a size the RFQ control can actually reach -- one of the four
 * presets, or the Risk Budget remaining (what `Max` sets it to). Never computed: every
 * string here already exists, either as a literal preset label or as the server's own
 * Figure. A size this function does not recognise (unreachable through this control, but
 * defensive) reads as "—" rather than a guess.
 */
function sizeDisplay(usdc: number, session: SessionState | null): string {
  const preset = SIZE_PRESETS_USDC.find((p) => p.usdc === usdc);
  if (preset) return preset.label;
  if (session && usdc === rfqSizeCapUsdc(session.remainingUsdc)) return session.figures.remainingUsdc.display;
  return "—";
}

/** The label above the waiting block. Mirrors the phase, never softens it. */
const PHASE_LABEL: Record<RfqStatus["phase"], string> = {
  AWAITING_SIGNATURE: "not sent",
  OPEN: "live · waiting for makers",
  OFFERED: "a maker answered",
  NO_OFFERS: "nobody answered",
  SETTLED: "bought",
  CANCELLED: "withdrawn",
};

export function RfqModal({
  open,
  asset,
  direction,
  spot,
  offsetPct,
  horizonDays,
  sizeUsdc,
  session,
  busy,
  refusal,
  status,
  settle,
  receipt,
  wallet,
  onOffsetCommit,
  onTenor,
  onResize,
  onSubmit,
  onAccept,
  onWithdraw,
  onClose,
}: {
  open: boolean;
  asset: UnderlyingSymbol;
  direction: Direction;
  spot: Figure | null;
  /** The slider's last COMMITTED offset -- set on release, read here only to seed the drag. */
  offsetPct: number;
  horizonDays: RfqTenorDays;
  sizeUsdc: number;
  session: SessionState | null;
  busy: boolean;
  /** A refusal the Trader is meant to read, shown verbatim. Never composed here. */
  refusal: string | null;
  /** The live request, once one exists on-chain. Null while the Trader is still asking. */
  status: RfqStatus | null;
  /** The prepared second signature, once a maker's price has been accepted. */
  settle: PreparedRfqSettle | null;
  receipt: FillReceipt | null;
  /**
   * The connected wallet, passed through to the control below.
   *
   * The control lives INSIDE this dialog, the same way it lives inside `ConfirmModal`:
   * opening a request is a transaction, and a Trader who reaches the one button that
   * sends it must be able to connect from where they are standing rather than being told
   * to go and find a control somewhere else on the page.
   */
  wallet: {
    address: string | null;
    connecting: boolean;
    verified: boolean;
    verifying: boolean;
    error: string | null;
    onConnect: () => void;
    onVerify: () => void;
  };
  /** Fires once, on the slider's release -- never mid-drag. */
  onOffsetCommit: (pct: number) => void;
  onTenor: (days: RfqTenorDays) => void;
  onResize: (usdc: number) => void;
  onSubmit: () => void;
  onAccept: () => void;
  onWithdraw: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /**
   * The slider's LIVE value while dragging. Local to this component and nowhere else --
   * pushing every pixel of pointer movement through `lib/surface.ts` would re-render the
   * whole surface for a value nothing outside this dialog reads. Reseeded from the
   * committed `offsetPct` whenever the dialog opens.
   */
  const [dragPct, setDragPct] = useState(offsetPct);
  useEffect(() => {
    if (open) setDragPct(offsetPct);
  }, [open, offsetPct]);

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

  if (!open) return null;

  // Once a request exists on-chain the controls are frozen for good: what was signed
  // cannot be edited, and offering an edit that silently does nothing would be worse
  // than offering none.
  const requested = status !== null;
  const frozen = busy || requested;
  const cap = rfqSizeCapUsdc(session?.remainingUsdc ?? 0);
  const walletReady = Boolean(wallet.address) && wallet.verified;
  const canAsk = !frozen && cap >= SIZE_MIN_USDC && walletReady;

  const directionWord = direction === "DOWN" ? "below" : "above";
  const commitDrag = () => onOffsetCommit(dragPct);
  const maxLossDisplay = sizeDisplay(sizeUsdc, session);

  const bar = riskBudgetBar(session?.riskBudgetUsdc ?? 0, session?.spentUsdc ?? 0, sizeUsdc);

  // The premium, once one exists. Preferred off `settle` because that is the figure
  // attached to the transaction being signed; `status` is what the poll last read.
  const premium = settle?.premiumUsdc ?? status?.premiumUsdc ?? null;
  const answered = status?.phase === "OFFERED";
  const settled = status?.phase === "SETTLED";
  const unanswered = status?.phase === "NO_OFFERS";

  return (
    <>
      <div className="scrim" data-testid="rfq-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Request a quote"
        data-testid="rfq-modal"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <Mark symbol={asset} size={30} />
          <div>
            <b>
              {asset} {spot ? spot.display : "—"}
            </b>
            <small>Request a quote</small>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="belief" data-testid="rfq-belief">
          You believe <em>{asset}</em> will be
          <br />
          <em>{directionWord}</em>{" "}
          <em data-testid="rfq-offset">
            {/* Once the request exists, the server's own dollar strike replaces the
                percentage -- it is a string it derived, rendered verbatim. */}
            {status ? status.ask.strike.display : `spot ${dragPct >= 0 ? "+" : ""}${dragPct}%`}
          </em>
          <br />
          in <em>{horizonDays} days</em>
        </p>

        <div className="ctl">
          <div className="ctlhead">
            <span className="mk2">Strike</span>
            <span className="off">
              spot {spot ? spot.display : "—"} ·{" "}
              <b data-testid="rfq-offset-readout">
                {dragPct >= 0 ? "+" : ""}
                {dragPct}%
              </b>
            </span>
          </div>
          <input
            className="slider"
            type="range"
            min={-RFQ_STRIKE_BAND_PCT}
            max={RFQ_STRIKE_BAND_PCT}
            step={RFQ_STRIKE_STEP_PCT}
            value={dragPct}
            disabled={frozen}
            onChange={(e) => setDragPct(Number(e.target.value))}
            onMouseUp={commitDrag}
            onTouchEnd={commitDrag}
            onKeyUp={commitDrag}
            onBlur={commitDrag}
            aria-label="Strike, as a percentage from spot"
            data-testid="rfq-strike-slider"
          />
          <div className="scale" aria-hidden="true">
            <span>−{RFQ_STRIKE_BAND_PCT}%</span>
            <span className="mid">spot</span>
            <span>+{RFQ_STRIKE_BAND_PCT}%</span>
          </div>
        </div>

        <div className="ctl">
          <div className="ctlhead">
            <span className="mk2">Expires in</span>
            <span className="off">the book stops at 3 days</span>
          </div>
          <div className="presets wide" role="group" aria-label="How long the quote is requested for">
            {RFQ_TENOR_DAYS.map((n) => (
              <button
                key={n}
                type="button"
                className="pre"
                aria-pressed={horizonDays === n}
                disabled={frozen}
                onClick={() => onTenor(n)}
                data-testid={`rfq-tenor-${n}`}
              >
                {n} days
              </button>
            ))}
          </div>
        </div>

        <div className="ctl">
          <div className="ctlhead">
            <span className="mk2">Size</span>
          </div>
          <div className="presets" role="group" aria-label="Preset sizes">
            {SIZE_PRESETS_USDC.map((p) => (
              <button
                key={p.usdc}
                type="button"
                className="pre"
                aria-pressed={sizeUsdc === p.usdc}
                disabled={frozen || p.usdc > cap}
                onClick={() => onResize(p.usdc)}
                data-testid={`rfq-size-preset-${p.usdc}`}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className="pre"
              aria-pressed={sizeUsdc === cap}
              disabled={frozen || cap < SIZE_MIN_USDC}
              onClick={() => onResize(cap)}
              data-testid="rfq-size-max"
            >
              Max
            </button>
          </div>

          <div className="bud">
            <span className="budbar">
              <i style={{ width: `${bar.spentPct}%` }} aria-hidden="true" />
            </span>
            <span data-testid="rfq-risk-remaining">
              {maxLossDisplay} of {session ? session.figures.riskBudgetUsdc.display : "—"} risk budget
            </span>
          </div>
        </div>

        <dl>
          <dt>Max Loss</dt>
          <dd className="hero" data-testid="rfq-max-loss">
            {status ? status.ask.reservePriceUsdc.display : maxLossDisplay}
          </dd>
          <dt>Premium</dt>
          {/*
           * The one figure this dialog is most careful about. It stays "not priced yet"
           * for the whole of the asking and the whole of the wait, because until a maker
           * answers there genuinely is not one -- and the Reserve Price sitting right
           * above it is a ceiling, not a substitute for it.
           */}
          <dd className={premium ? "" : "muted"} data-testid="rfq-premium">
            {premium ? premium.display : "not priced yet"}
          </dd>
          <dt>Chance it pays</dt>
          <dd className="muted" data-testid="rfq-chance">
            not priced yet
          </dd>
        </dl>

        {!requested ? (
          <p className="mnote" data-testid="rfq-reserve-note">
            Your size is the <b>reserve price</b> — the most you will pay. It is enforced on-chain, so this
            ceiling holds whatever a maker quotes. No premium is shown because there is not one yet: an RFQ
            has no price until an Offer answers it.
          </p>
        ) : null}

        {/*
         * The wait, and everything after it. `role="status"` is a POLITE live region: an
         * offer arriving is news, not an emergency, and it announces once assistive
         * technology is ready rather than interrupting. Every string in here was written
         * by the server -- the phase sentence included.
         */}
        {status ? (
          <div
            className={`receipt${settled ? " ok" : ""}`}
            role="status"
            data-testid="rfq-wait"
            data-phase={status.phase}
          >
            <b>{PHASE_LABEL[status.phase]}</b>
            <p data-testid="rfq-wait-sentence">{status.sentence}</p>
            {status.phase === "OPEN" || status.phase === "OFFERED" ? (
              <p className="mnote" data-testid="rfq-offer-count">
                {status.offers.display} answered so far · offers close {status.ask.offersCloseAt.display}
              </p>
            ) : null}
          </div>
        ) : null}

        {receipt?.explorerUrl ? (
          <div className="receipt ok" data-testid="rfq-receipt">
            <b>transaction</b>
            <a href={receipt.explorerUrl} target="_blank" rel="noreferrer">
              View on Basescan
            </a>
          </div>
        ) : null}

        {refusal ? (
          <div className="receipt" role="alert" data-testid="rfq-refusal">
            <b>not done</b>
            <p>{refusal}</p>
          </div>
        ) : null}

        {!requested ? (
          <>
            <p className="mnote" data-testid="rfq-gate">
              {walletReady
                ? "Opening a request is a transaction your own wallet sends. Nothing is bought by it."
                : "Connect and verify your wallet first — opening a request is a transaction your own wallet sends."}
            </p>
            <WalletConnect
              address={wallet.address}
              connecting={wallet.connecting}
              verified={wallet.verified}
              verifying={wallet.verifying}
              error={wallet.error}
              onConnect={wallet.onConnect}
              onVerify={wallet.onVerify}
            />
          </>
        ) : null}

        <footer>
          {/*
           * One primary action at a time, and which one it is says where the flow is.
           * Asking offers "Request quotes"; a maker's answer replaces it with the price
           * itself, so the button a Trader presses to spend money names the amount.
           */}
          {settled ? null : answered ? (
            <button type="button" className="btn primary" disabled={busy} onClick={onAccept} data-testid="rfq-accept">
              {busy ? "Paying…" : `Pay ${premium ? premium.display : "the offer"}`}
            </button>
          ) : requested ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={onWithdraw}
              data-testid="rfq-withdraw"
            >
              {unanswered ? "Withdraw request" : "Withdraw"}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!canAsk} onClick={onSubmit} data-testid="rfq-submit">
              {busy ? "Opening…" : "Request quotes"}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose} data-testid="rfq-cancel">
            {settled ? "Done" : "Close"}
          </button>
        </footer>
      </div>
    </>
  );
}
