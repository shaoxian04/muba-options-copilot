"use client";

/**
 * Issue #30 -- the confirmation replaces the commit bar.
 *
 * The persistent commit bar pinned Confirm to the bottom of the screen at all times,
 * one stray click from a real Fill, and let a Trader confirm while their attention was
 * somewhere else entirely. Clicking a Card opens THIS instead, and it holds the only
 * Confirm in the product -- committing is now a deliberate act arrived at, not a click
 * on a bar that was always there.
 *
 * Four things this file is careful never to do:
 *
 *   - Name the instrument. The belief statement says what the Trader is betting on in
 *     plain language -- "You believe ETH will be below $2,420" -- and never CALL or PUT.
 *   - Compute a figure. Every dollar amount on screen is a `.display` string that came
 *     off the wire; changing the size re-fetches the Order and re-derives everything
 *     server-side (`setSize` in `lib/surface.ts`), exactly the way picking a different
 *     Card already does. The one number this file originates is the SIZE ITSELF -- a
 *     request parameter, not a figure anyone reads, the same way `STAKE_USDC` already
 *     travelled to `/propose` before this ticket existed.
 *   - Celebrate a Fill. Implied Chance across the live book runs roughly 1% to 62%, so
 *     most Cards expire worthless -- no confetti, no streak, no leaderboard, ever.
 *   - Let Confirm out-compete Practice Run. Practice is the solid, prominent button;
 *     Confirm is the quiet, outlined one, so trying the flow is always the path of
 *     least resistance and spending real USDC never is.
 */
import { useEffect, useRef } from "react";
import type { Card, Figure, TradeProposal, UnderlyingSymbol } from "@copilot/shared";
import { countdown } from "../lib/clock";
import { clampSizeUsdc, expectedMoveIndex, riskBudgetBar, sizeCapUsdc } from "../lib/geometry";
import { SIZE_MIN_USDC, SIZE_PRESETS_USDC, SIZE_STEP_USDC, type Direction, type GateState } from "../lib/surface";
import type { FillReceipt, SessionState } from "../lib/api";
import { Mark } from "./Rail";
import { PayoffStrip } from "./PayoffStrip";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmModal({
  open,
  asset,
  direction,
  spot,
  now,
  card,
  proposal,
  impliedMoveUsd,
  session,
  sizeUsdc,
  busy,
  quoteMoved,
  refusal,
  receipt,
  practiceDone,
  gates,
  onResize,
  onConfirm,
  onPractice,
  onClose,
}: {
  open: boolean;
  asset: UnderlyingSymbol;
  direction: Direction;
  spot: Figure | null;
  now: number;
  /** The picked Order's strike-level figures: chance, depth, who else holds it. */
  card: Card | null;
  /** The current stake's re-derived figures. Null only while a refusal has nothing to price. */
  proposal: TradeProposal | null;
  /** The Implied Move at the Deck's horizon, for the "expected move" payout row. */
  impliedMoveUsd: Figure | null;
  session: SessionState | null;
  sizeUsdc: number;
  busy: boolean;
  quoteMoved: boolean;
  refusal: string | null;
  receipt: FillReceipt | null;
  practiceDone: boolean;
  gates: Array<{ label: string; state: GateState }>;
  onResize: (usdc: number) => void;
  onConfirm: () => void;
  onPractice: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /*
   * On open, move focus into the dialog.
   *
   * Returning it to the Card that opened the dialog is NOT done here: `pick()` in
   * `lib/surface.ts` disables that Card the same instant it opens this modal (so a
   * second click cannot fire mid-request), and a browser blurs a focused element to
   * `<body>` the moment it goes disabled -- by the time this effect runs, the opener
   * is already gone from `document.activeElement`. `surface.ts` captures it a render
   * earlier than that, synchronously in `pick()`, and restores it in `closeConfirm`.
   */
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

  // Done: a receipt exists, or a Practice Run opened. Either way the flow is over --
  // the size control and both buttons freeze so a second press cannot resubmit a
  // proposal the server has already consumed.
  const done = Boolean(receipt) || practiceDone;
  const canAct = Boolean(proposal) && !quoteMoved && !busy && !done;

  const cap = sizeCapUsdc(session?.remainingUsdc ?? 0, card?.depthUsdc.value ?? 0);
  const resize = (v: number) => onResize(clampSizeUsdc(v, SIZE_MIN_USDC, cap));

  const directionWord = direction === "DOWN" ? "below" : "above";
  const offerWord = card && card.depthOrders.value === 1 ? "offer" : "offers";

  const moveIndex = proposal
    ? expectedMoveIndex(proposal.payoffCurve, spot?.value ?? 0, impliedMoveUsd?.value ?? null, direction)
    : -1;
  const movePoint = moveIndex >= 0 ? proposal!.payoffCurve[moveIndex] : null;

  const bar = riskBudgetBar(
    session?.riskBudgetUsdc ?? 0,
    session?.spentUsdc ?? 0,
    proposal?.figures.premiumUsdc.value ?? 0
  );

  return (
    <>
      <div className="scrim" data-testid="scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm the trade"
        data-testid="confirm-modal"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <Mark symbol={asset} size={30} />
          <div>
            <b>
              {asset} {spot ? spot.display : "—"}
            </b>
            <small>Confirm</small>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {proposal ? (
          <>
            <p className="belief" data-testid="belief">
              You believe <em>{asset}</em> will be
              <br />
              <em>{directionWord}</em> <em>{proposal.figures.strike.display}</em>
              <br />
              in{" "}
              <em className="ticks" data-testid="belief-countdown">
                {countdown(proposal.figures.expiry.value, now)}
              </em>
            </p>

            <PayoffStrip proposal={proposal} spot={spot} />

            <div className="ctl">
              <div className="ctlhead">
                <span className="mk2">Size</span>
                <div className="stepper">
                  <button
                    type="button"
                    onClick={() => resize(sizeUsdc - SIZE_STEP_USDC)}
                    disabled={!canAct || sizeUsdc <= SIZE_MIN_USDC}
                    aria-label="Decrease size"
                    data-testid="size-decrease"
                  >
                    −
                  </button>
                  <b data-testid="size-value">{proposal.figures.premiumUsdc.display}</b>
                  <button
                    type="button"
                    onClick={() => resize(sizeUsdc + SIZE_STEP_USDC)}
                    disabled={!canAct || sizeUsdc >= cap}
                    aria-label="Increase size"
                    data-testid="size-increase"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="presets" role="group" aria-label="Preset sizes">
                {SIZE_PRESETS_USDC.map((p) => (
                  <button
                    key={p.usdc}
                    type="button"
                    className="pre"
                    aria-pressed={sizeUsdc === p.usdc}
                    disabled={!canAct || p.usdc > cap}
                    onClick={() => resize(p.usdc)}
                    data-testid={`size-preset-${p.usdc}`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="pre"
                  aria-pressed={sizeUsdc === cap}
                  disabled={!canAct || cap < SIZE_MIN_USDC}
                  onClick={() => resize(cap)}
                  data-testid="size-max"
                >
                  Max
                </button>
              </div>

              <div className="bud">
                <span className="budbar">
                  <i style={{ width: `${bar.spentPct}%` }} aria-hidden="true" />
                  <i className="pend" style={{ width: `${bar.pendingPct}%` }} aria-hidden="true" data-testid="risk-pending" />
                </span>
                <span data-testid="risk-remaining">
                  {proposal.figures.premiumUsdc.display} of {session ? session.figures.riskBudgetUsdc.display : "—"}{" "}
                  risk budget
                </span>
              </div>
            </div>

            <p className="sub2" data-testid="contracts-readout">
              {proposal.figures.contracts.display} contracts at {proposal.figures.perContractUsd.display} each
            </p>

            <dl>
              <dt>Max Loss</dt>
              <dd className="hero" data-testid="max-loss">
                {proposal.figures.maxLossUsdc.display}
              </dd>
              <dt>Chance it pays</dt>
              <dd data-testid="chance-pays">{card ? `${card.impliedChance.display} · ${card.chanceLabel}` : "—"}</dd>
              <dt>Pays if it lands on the expected move</dt>
              <dd data-testid="expected-move-payout">{movePoint ? movePoint.returnUsdc.display : "—"}</dd>
              <dt>Maker depth here</dt>
              <dd data-testid="depth-here">
                {card ? `${card.depthUsdc.display} · ${card.depthOrders.display} ${offerWord}` : "—"}
              </dd>
            </dl>

            <ul className="gate" aria-label="Who has to agree before anything is signed">
              {gates.map((g) => (
                <li key={g.label} className={g.state}>
                  <i aria-hidden="true" />
                  {g.label}
                  <span className="sr">
                    {g.state === "pass" ? " — done" : g.state === "fail" ? " — stopped" : " — waiting"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="belief" data-testid="belief-gone">
            That Card could not be priced.
          </p>
        )}

        {quoteMoved ? (
          <p className="refusal" role="alert" data-testid="quote-moved">
            <span aria-hidden="true">⚠</span>
            The price moved while you were looking. Close this and pick again — you will not be filled at a price
            you have not seen.
          </p>
        ) : null}

        {refusal ? (
          <p className="refusal" role="alert" data-testid="refusal">
            <span aria-hidden="true">⚠</span>
            {refusal}
          </p>
        ) : null}

        {receipt ? (
          <p className="receipt ok" role="status" data-testid="receipt">
            <b>Bought</b>
            <a href={receipt.explorerUrl} target="_blank" rel="noreferrer noopener">
              See it on the chain
            </a>
          </p>
        ) : practiceDone ? (
          <p className="receipt ok" role="status" data-testid="practice-receipt">
            <b>Practice run opened</b>
            No money moved — <code>/practice</code> cannot reach a signer at all.
          </p>
        ) : null}

        <footer>
          <button
            type="button"
            className="btn primary"
            data-testid="practice"
            disabled={!canAct}
            onClick={onPractice}
          >
            Practice Run · spends nothing
          </button>
          <button type="button" className="btn ghost" data-testid="confirm" disabled={!canAct} onClick={onConfirm}>
            Confirm{proposal ? ` · ${proposal.figures.maxLossUsdc.display}` : ""}
          </button>
        </footer>
      </div>
    </>
  );
}
