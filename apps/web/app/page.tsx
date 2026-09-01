"use client";

/**
 * The trading surface.
 *
 * Left is language, right is money, and the two never swap jobs: the Copilot on the
 * left proposes and explains and cannot spend, and every figure on the right came off
 * the wire already formatted.
 *
 * The right column has three shapes, chosen by what `/propose` last answered. A
 * PROPOSAL is the Deck; a VETO and a NO_ORDER each replace it entirely, because a halt
 * that renders as a small red note beside a live Deck is a halt a Trader scrolls past.
 *
 * Issue #30: there is no more persistent commit bar. Clicking a Card opens
 * `ConfirmModal`, which holds the only Confirm in the product -- so the Deck section
 * below is the one place left that can put a Trader in front of it.
 */
import { Board } from "../components/Board";
import { Chat, type Seed } from "../components/Chat";
import { Chips } from "../components/Chips";
import { ConfirmModal } from "../components/ConfirmModal";
import { DeckRow } from "../components/DeckRow";
import { DepthChart } from "../components/DepthChart";
import { EmptyDeck, VetoScreen } from "../components/Halt";
import { PayoffStrip } from "../components/PayoffStrip";
import { Rail } from "../components/Rail";
import { Tape } from "../components/Tape";
import { agentGate, useNow, useSurface } from "../lib/surface";

export default function Page() {
  const s = useSurface();
  const now = useNow();

  const proposal = s.result?.kind === "PROPOSAL" ? s.result.proposal : null;

  /**
   * The chip's own label for the selected horizon ("2d"), so the statistics strip's
   * "Expected move" cell can say which one without this file turning a number into
   * text itself. Absent only when the Deck has not answered yet.
   */
  const horizonLabel = s.deck?.expiries.find((e) => e.horizonDays === s.horizonDays)?.label;

  /**
   * The seed prompts, naming whatever the rail has selected.
   *
   * They FOLLOW the picker; they do not drive it. Pressing one asks for a Deck on the
   * Underlying already selected -- it never switches Underlying, because reading an
   * asset out of a sentence is the Trade Agent's job and that service does not exist
   * yet (ADR-0007). Until it does, the rail is the only thing that moves the selection.
   */
  const seeds: Seed[] = [
    {
      said: `I think ${s.asset} drops before Friday`,
      run: () => void s.deal(`I think ${s.asset} drops before Friday`, "DOWN"),
    },
    { said: "What if it goes up instead?", run: () => void s.deal("What if it goes up instead?", "UP") },
    {
      said: "What is this, in one line?",
      run: () =>
        s.say(
          `You pay a little now. If ${s.asset} finishes past the number on the card, you get paid the ` +
            "difference. If it does not, you lose what you paid and not a cent more."
        ),
    },
  ];

  return (
    <main className="app">
      <Chat log={s.log} seeds={seeds} busy={s.busy} />

      <div className="rig">
        <Rail markets={s.markets} asset={s.asset} onPick={s.setAsset} />
        <Tape deck={s.deck} now={now} />

        {/*
          The statistics strip and the Maker Depth chart (issue #28). Unfiltered by
          direction and by expiry on purpose -- see `DepthChart.tsx` -- so it sits here,
          outside every branch below it, and keeps orienting a Trader through a VETO or
          an empty Deck rather than disappearing with them.
        */}
        {s.depth ? <DepthChart depth={s.depth} horizonDays={s.horizonDays} horizonLabel={horizonLabel} /> : null}

        {s.result?.kind === "VETO" ? (
          <VetoScreen
            tradeIntent={s.result.tradeIntent}
            reviewIntent={s.result.reviewIntent}
            clashingFields={s.result.clashingFields}
            onRetry={s.reset}
          />
        ) : s.result?.kind === "NO_ORDER" || (s.deck && s.deck.cards.length === 0) ? (
          <EmptyDeck
            message={
              s.result?.kind === "NO_ORDER"
                ? s.result.message
                : s.deck?.message ?? "No maker is quoting this right now."
            }
            onRetry={s.reset}
          />
        ) : (
          <>
            <div className="body">
              <section className="sect" aria-label="The Deck">
                <div className="cap">
                  {/*
                    Direction and expiry in one row, in the order variant E settles on:
                    Falls, Rises, a separator, then the expiry chips. The door that names
                    your own strike joins the end of this row in ticket #31.
                  */}
                  <Chips
                    deck={s.deck}
                    direction={s.direction}
                    horizonDays={s.horizonDays}
                    onDirection={s.setDirection}
                    onHorizon={s.setHorizon}
                  />

                  {proposal ? (
                    <span className={`tag${proposal.chosenBy === "TRADER" ? " mine" : ""}`} data-testid="chosen-by">
                      <i aria-hidden="true" />
                      {proposal.chosenBy === "TRADER" ? "your pick, not the agent's" : "the agent picked this"}
                    </span>
                  ) : null}
                </div>

                {s.loading && !s.deck ? (
                  <p className="loading">Reading the book…</p>
                ) : s.deckError ? (
                  <p className="loading" role="alert">
                    {s.deckError}
                  </p>
                ) : s.deck ? (
                  <DeckRow
                    deck={s.deck}
                    selectedRef={s.selectedRef}
                    dealtRef={s.dealtRef}
                    busy={s.busy}
                    now={now}
                    onPick={(ref) => void s.pick(ref)}
                  />
                ) : null}
              </section>

              {proposal ? (
                <section className="sect" aria-label="What this pays">
                  <PayoffStrip proposal={proposal} spot={s.deck?.spotUsd ?? null} />
                </section>
              ) : null}

              <section className="sect" aria-label="What you hold">
                <span className="lbl">Yours</span>
                <Board holdings={s.board?.holdings ?? []} now={now} />
              </section>
            </div>

            <ConfirmModal
              open={s.confirmOpen}
              asset={s.asset}
              direction={s.direction}
              spot={s.deck?.spotUsd ?? null}
              now={now}
              card={s.selectedCard}
              proposal={proposal}
              impliedMoveUsd={s.depth?.stats.impliedMoveUsd ?? null}
              session={s.session}
              sizeUsdc={s.sizeUsdc}
              busy={s.busy}
              quoteMoved={s.quoteMoved}
              refusal={s.refusal}
              receipt={s.receipt}
              practiceDone={s.practiceDone}
              gates={agentGate(s.result)}
              onResize={(usdc) => void s.setSize(usdc)}
              onConfirm={() => void s.confirm()}
              onPractice={() => void s.runPractice()}
              onClose={s.closeConfirm}
            />
          </>
        )}
      </div>
    </main>
  );
}
