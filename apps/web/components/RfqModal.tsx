"use client";

/**
 * Issue #31 -- the RFQ door's dialog: naming a strike the book does not offer.
 *
 * Opens the SAME SHAPE of confirmation `ConfirmModal` does -- the same scrim, the
 * same focus trap, the same belief statement, the same labelled list -- so a Trader
 * does not have to learn a second interface for the rarer thing. What differs is what
 * there is to show: an RFQ has no premium and no Implied Chance, because neither
 * exists until an Offer answers it, and this file is careful never to invent either.
 *
 * The one habit dropped from `prototype-deck-v2.html`'s `rfqModal`/`strikeControl`:
 * the prototype computed a dollar strike ON THE PAGE as the slider dragged
 * (`dragStrike` called `usd(spot * (1 + pct/100))` in the browser). That is exactly
 * the number ADR-0006 says a model -- or a component -- may never originate: nobody
 * has priced this strike, server included, so a dollar figure for it does not exist
 * anywhere until the 501 refusal computes one off live spot and echoes it back. Until
 * then, the slider and the belief sentence below speak only in the percentage terms
 * the slider itself uses -- the one thing about an unpriced strike that IS true
 * without needing arithmetic on a Figure.
 *
 * The size control reuses `ConfirmModal`'s presets and budget bar, but not its
 * stepper: a Card's stepper reads its live dollar value off a fresh `/propose`
 * answer for every cent it moves, and an RFQ has nothing to re-price. Rather than
 * inventing a currency string for an arbitrary in-between value -- which the
 * exempt-module test would let through but the invariant it enforces would not --
 * the RFQ's size snaps to the same four presets plus Max, each of which already
 * carries a real string: the preset's own literal label, or `Max`'s the server's own
 * `session.figures.remainingUsdc.display`.
 */
import { useEffect, useRef, useState } from "react";
import type { Figure, RfqTenorDays, UnderlyingSymbol } from "@copilot/shared";
import { riskBudgetBar, rfqSizeCapUsdc } from "../lib/geometry";
import {
  RFQ_STRIKE_BAND_PCT,
  RFQ_STRIKE_STEP_PCT,
  RFQ_TENOR_DAYS,
  SIZE_MIN_USDC,
  SIZE_PRESETS_USDC,
  type Direction,
} from "../lib/surface";
import type { SessionState } from "../lib/api";
import { Mark } from "./Rail";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dollar string for a size the RFQ control can actually reach -- one of the four
 * presets, or the Risk Budget remaining (what `Max` sets it to). Never computed:
 * every string here already exists, either as a literal preset label or as the
 * server's own Figure. A size this function does not recognise (unreachable through
 * this control, but defensive) reads as "—" rather than a guess.
 */
function sizeDisplay(usdc: number, session: SessionState | null): string {
  const preset = SIZE_PRESETS_USDC.find((p) => p.usdc === usdc);
  if (preset) return preset.label;
  if (session && usdc === rfqSizeCapUsdc(session.remainingUsdc)) return session.figures.remainingUsdc.display;
  return "—";
}

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
  onOffsetCommit,
  onTenor,
  onResize,
  onSubmit,
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
  /** The 501's own sentence, shown verbatim once the Trader has asked. */
  refusal: string | null;
  /** Fires once, on the slider's release -- never mid-drag. */
  onOffsetCommit: (pct: number) => void;
  onTenor: (days: RfqTenorDays) => void;
  onResize: (usdc: number) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /**
   * The slider's LIVE value while dragging. Local to this component and nowhere else
   * -- pushing every pixel of pointer movement through `lib/surface.ts` would
   * re-render the whole surface for a value nothing outside this dialog reads.
   * Reseeded from the committed `offsetPct` whenever the dialog opens.
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

  const frozen = busy || Boolean(refusal);
  const cap = rfqSizeCapUsdc(session?.remainingUsdc ?? 0);
  const canAct = !frozen && cap >= SIZE_MIN_USDC;

  const directionWord = direction === "DOWN" ? "below" : "above";
  const commitDrag = () => onOffsetCommit(dragPct);
  const maxLossDisplay = sizeDisplay(sizeUsdc, session);

  const bar = riskBudgetBar(session?.riskBudgetUsdc ?? 0, session?.spentUsdc ?? 0, sizeUsdc);

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
            spot {dragPct >= 0 ? "+" : ""}
            {dragPct}%
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
            {maxLossDisplay}
          </dd>
          <dt>Premium</dt>
          <dd className="muted" data-testid="rfq-premium">
            not priced yet
          </dd>
          <dt>Chance it pays</dt>
          <dd className="muted" data-testid="rfq-chance">
            not priced yet
          </dd>
        </dl>

        <p className="mnote" data-testid="rfq-reserve-note">
          Your size is the <b>reserve price</b> — the most you will pay. It is enforced on-chain, so this
          ceiling holds whatever a maker quotes. No premium is shown because there is not one yet: an RFQ
          has no price until an Offer answers it.
        </p>

        {refusal ? (
          <div className="receipt" role="alert" data-testid="rfq-refusal">
            <b>501 · not built yet</b>
            <p>{refusal}</p>
          </div>
        ) : null}

        <footer>
          <button type="button" className="btn primary" disabled={!canAct} onClick={onSubmit} data-testid="rfq-submit">
            Request quotes
          </button>
          <button type="button" className="btn ghost" onClick={onClose} data-testid="rfq-cancel">
            Cancel
          </button>
        </footer>
      </div>
    </>
  );
}
