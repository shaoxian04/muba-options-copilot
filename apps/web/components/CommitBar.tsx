"use client";

/**
 * Max Loss, the Risk Budget, the agent gate, and the two ways to finish.
 *
 * Fixed, so a Trader is never looking at an upside figure without the downside beside
 * it -- the reason this is a bar and not a section is that a section scrolls away and
 * an upside number left alone on screen is the failure this whole product is built to
 * avoid.
 *
 * Max Loss does not change as they flick between Cards. That is not a rendering trick:
 * we only ever buy (ADR-0002), so the most that can be lost IS the premium, and the
 * premium is the stake. Watching the figure sit still while everything else moves is
 * how a first-timer learns that their downside is bounded no matter what they pick.
 *
 * Confirm and Practice Run call two different functions, on two different routes. There
 * is deliberately no shared handler taking a mode -- see `apps/api/src/practice.ts` for
 * why a boolean is the wrong shape for this decision.
 */
import type { Figure } from "@copilot/shared";
import type { GateState } from "../lib/surface";
import { riskBudgetBar } from "../lib/geometry";
import type { FillReceipt, SessionState } from "../lib/api";

export interface Gate {
  label: string;
  state: GateState;
}

export function CommitBar({
  maxLoss,
  session,
  pending,
  gates,
  canCommit,
  walletConnected,
  busy,
  refusal,
  receipt,
  quoteMoved,
  onConfirm,
  onPractice,
}: {
  maxLoss: Figure | null;
  session: SessionState | null;
  /** What the Fill in front of the Trader would consume. Zero when nothing is picked. */
  pending: number;
  gates: Gate[];
  canCommit: boolean;
  /** Confirm needs a signature from the Trader's own wallet; Practice Run never does. */
  walletConnected: boolean;
  busy: boolean;
  refusal: string | null;
  /** What the chain did, once it has done it. */
  receipt: FillReceipt | null;
  quoteMoved: boolean;
  onConfirm: () => void;
  onPractice: () => void;
}) {
  const bar = riskBudgetBar(session?.riskBudgetUsdc ?? 0, session?.spentUsdc ?? 0, pending);

  return (
    <div className="commit" data-testid="commit-bar">
      <div className="maxloss">
        <span className="lbl">Most you can lose</span>
        <b data-testid="max-loss">{maxLoss ? maxLoss.display : "—"}</b>
      </div>

      <div className="risk">
        <div className="bar" data-testid="risk-bar">
          <i style={{ width: `${bar.spentPct}%` }} aria-hidden="true" />
          {/* The ghost: what pressing Confirm would take, drawn before it is taken. */}
          <i className="pend" style={{ width: `${bar.pendingPct}%` }} aria-hidden="true" data-testid="risk-pending" />
        </div>
        <div className="rowx">
          <span>Risk budget</span>
          <span className="n" data-testid="risk-remaining">
            {session ? `${session.figures.remainingUsdc.display} of ${session.figures.riskBudgetUsdc.display} left` : "—"}
          </span>
        </div>
      </div>

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

      <button
        type="button"
        className="go prac"
        data-testid="practice"
        disabled={!canCommit || busy}
        onClick={onPractice}
      >
        Practice run · no money
      </button>

      <button
        type="button"
        className="go"
        data-testid="confirm"
        disabled={!canCommit || !walletConnected || busy}
        onClick={onConfirm}
      >
        {maxLoss ? `Confirm · ${maxLoss.display}` : "Confirm"}
      </button>

      {canCommit && !walletConnected ? (
        <p className="refusal" role="status" data-testid="wallet-gate">
          Connect a wallet above to Confirm — Practice Run needs no wallet at all.
        </p>
      ) : null}

      {quoteMoved ? (
        <p className="refusal" role="alert" data-testid="quote-moved">
          <span aria-hidden="true">⚠</span>
          The price moved while you were looking. Pick again — you will not be filled at a price you have not seen.
        </p>
      ) : null}

      {refusal ? (
        <p className="refusal" role="alert" data-testid="refusal">
          <span aria-hidden="true">⚠</span>
          {refusal}
        </p>
      ) : null}

      {/*
        A Trader who has just spent real money and been handed no transaction to look at
        has been asked to take our word for it, at the one moment they should not have
        to. The chain is the record; this is the link to it.
      */}
      {receipt ? (
        <p className="receipt" role="status" data-testid="receipt">
          Bought.{" "}
          <a href={receipt.explorerUrl} target="_blank" rel="noreferrer noopener">
            See it on the chain
          </a>
        </p>
      ) : null}
    </div>
  );
}
