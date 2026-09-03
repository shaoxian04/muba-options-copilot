"use client";

/**
 * The two states where the surface has nothing to sell.
 *
 * A VETO stops the flow. The Review Agent's only power is to veto (ADR-0006), and when
 * it uses it a Trader deserves to see WHY rather than "something went wrong" -- so the
 * two readings sit side by side with the clashing fields marked, and they can judge the
 * disagreement themselves.
 *
 * It has to be unmistakable from across a room, because it will be read during a demo
 * or a hurried moment. That is done with size, a rule, a banner and the layout breaking
 * -- never with colour alone, which would exclude exactly the Traders the rest of this
 * surface was careful about. Take the red away and the screen still says NOTHING WAS
 * SIGNED in full caps above two cards that visibly do not match.
 *
 * An empty Deck is a market condition, not a broken app. It says when maker liquidity
 * reloads, so there is something to act on rather than something to refresh at.
 */
import type { TradeIntent } from "@copilot/shared";

const FIELDS: Array<keyof TradeIntent> = ["underlying", "direction", "sizeUsdc", "horizonDays"];

const READS: Record<keyof TradeIntent, string> = {
  underlying: "Asset",
  direction: "Bet",
  sizeUsdc: "Stake",
  horizonDays: "Days",
};

/**
 * A Trade Intent read out.
 *
 * `sizeUsdc` is shown as the bare number the agent produced, deliberately: this panel
 * is the two agents' RAW readings put next to each other, and dressing one up as
 * currency would suggest it had been through the pricing path. It has not -- a Veto
 * stops the flow before anything is priced.
 */
function Reading({ who, intent, clashing, mismatch }: { who: string; intent: TradeIntent; clashing: string[]; mismatch: boolean }) {
  return (
    <div className={`rd2 ${mismatch ? "b" : "a"}`}>
      <span className="lbl">{who}</span>
      <dl>
        {FIELDS.map((f) => {
          const bad = clashing.includes(f);
          return (
            <div key={f} style={{ display: "contents" }}>
              <dt>{READS[f]}</dt>
              <dd className={bad ? "bad" : ""}>
                {String(intent[f])}
                {bad ? <span className="sr"> — this is where they disagree</span> : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function VetoScreen({
  tradeIntent,
  reviewIntent,
  clashingFields,
  onRetry,
}: {
  tradeIntent: TradeIntent;
  reviewIntent: TradeIntent;
  clashingFields: string[];
  onRetry: () => void;
}) {
  return (
    <div className="halt" data-testid="veto" role="alert">
      <p className="banner">Nothing was signed</p>
      <h2>They read you differently.</h2>
      <p className="sub">
        Two agents took your sentence apart on their own and disagreed about{" "}
        {clashingFields.length ? clashingFields.join(" and ") : "what you meant"}. When they disagree, the trade stops
        here.
      </p>

      <div className="face">
        <Reading who="Trade Agent" intent={tradeIntent} clashing={clashingFields} mismatch={false} />
        <div className="split" aria-hidden="true">
          ≠
        </div>
        <Reading who="Review Agent" intent={reviewIntent} clashing={clashingFields} mismatch />
      </div>

      <button type="button" className="go" onClick={onRetry} data-testid="veto-retry">
        Say it again
      </button>
    </div>
  );
}

export function EmptyDeck({
  message,
  onRetry,
  onRfq,
}: {
  message: string;
  onRetry: () => void;
  /** Issue #31 -- the same RFQ dialog the door beside the chips opens, so an empty market is a next step rather than a dead end. */
  onRfq: () => void;
}) {
  return (
    <div className="halt" data-testid="empty-deck">
      <h2>Nobody is quoting this right now.</h2>
      {/* The server's sentence, which names when maker liquidity reloads. */}
      <p className="sub" data-testid="empty-deck-message">
        {message}
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" className="go prac" onClick={onRetry} data-testid="empty-retry">
          Look again
        </button>
        <button type="button" className="go" onClick={onRfq} data-testid="empty-rfq">
          Ask for one to be made
        </button>
      </div>
    </div>
  );
}
