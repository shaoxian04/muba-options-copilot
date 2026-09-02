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
 */
import { Board } from "../components/Board";
import { Chat, type Seed } from "../components/Chat";
import { CommitBar } from "../components/CommitBar";
import { DeckRow } from "../components/DeckRow";
import { EmptyDeck, VetoScreen } from "../components/Halt";
import { PayoffStrip } from "../components/PayoffStrip";
import { Tape } from "../components/Tape";
import { agentGate, agreedMaxLoss, useNow, useSurface, type Direction } from "../lib/surface";

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  // "Falls" and "Rises", never "put" and "call". A Trader should be able to express a
  // view without first learning the vocabulary of the instrument that expresses it.
  { value: "DOWN", label: "▾ Falls" },
  { value: "UP", label: "▴ Rises" },
];

export default function Page() {
  const s = useSurface();
  const now = useNow();

  const proposal = s.result?.kind === "PROPOSAL" ? s.result.proposal : null;

  /**
   * Max Loss, as early as it can honestly be shown.
   *
   * The proposal's figure once there is one; before that, the Deck's -- but only when
   * every Card in it agrees, which `agreedMaxLoss` is what checks. Both come from the
   * same `priceOrder` call, so the handover cannot make the figure jump.
   */
  const maxLoss = proposal?.figures.maxLossUsdc ?? s.selectedCard?.maxLossUsdc ?? agreedMaxLoss(s.deck);

  const canCommit = Boolean(proposal) && !s.quoteMoved && !s.busy;

  const seeds: Seed[] = [
    {
      said: "I think ETH drops before Friday",
      run: () => void s.deal("I think ETH drops before Friday", { direction: "DOWN" }),
    },
    {
      said: "What if it goes up instead?",
      run: () => void s.deal("What if it goes up instead?", { direction: "UP" }),
    },
    {
      said: "What is this, in one line?",
      run: () =>
        s.say(
          "You pay a little now. If ETH finishes past the number on the card, you get paid the difference. If it does not, you lose what you paid and not a cent more."
        ),
    },
  ];

  return (
    <main className="app">
      <Chat log={s.log} seeds={seeds} busy={s.busy} deal={s.deal} />

      <div className="rig">
        <Tape deck={s.deck} horizonDays={s.horizonDays} onHorizon={s.setHorizon} now={now} />

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
                  <div className="dir" role="group" aria-label="Which way you think ETH goes">
                    {DIRECTIONS.map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        aria-pressed={s.direction === d.value}
                        onClick={() => s.setDirection(d.value)}
                        data-testid={`direction-${d.value}`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>

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

            <CommitBar
              maxLoss={maxLoss}
              session={s.session}
              pending={proposal ? proposal.maxLossUsdc : 0}
              gates={agentGate(s.result)}
              canCommit={canCommit}
              busy={s.busy}
              refusal={s.refusal}
              receipt={s.receipt}
              quoteMoved={s.quoteMoved}
              onConfirm={() => void s.confirm()}
              onPractice={() => void s.runPractice()}
            />
          </>
        )}
      </div>
    </main>
  );
}
