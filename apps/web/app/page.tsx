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
import { AccountControl } from "../components/AccountControl";
import { Board } from "../components/Board";
import { Chat } from "../components/Chat";
import { Chips } from "../components/Chips";
import { ConfirmModal } from "../components/ConfirmModal";
import { DeckRow } from "../components/DeckRow";
import { DepthChart } from "../components/DepthChart";
import { EmptyDeck, VetoScreen } from "../components/Halt";
import { Rail } from "../components/Rail";
import { RfqModal } from "../components/RfqModal";
import { Tape } from "../components/Tape";
import { WalletPicker } from "../components/WalletPicker";
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

  return (
    <main className="app">
      <Chat
        log={s.log}
        busy={s.busy}
        submitTradeMessage={s.submitTradeMessage}
        deal={s.deal}
        pick={s.pick}
        signedIn={!!s.account}
      />

      <div className="rig">
        <AccountControl
          account={s.account}
          onSignOut={s.signOut}
          walletAddress={s.walletAddress}
          connecting={s.walletConnecting}
          verified={s.walletVerified}
          verifying={s.walletVerifying}
          error={s.walletError}
          onOpenWalletPicker={s.onOpenWalletPicker}
          onVerify={() => void s.verifyWallet()}
          onDisconnectWallet={s.onDisconnectWallet}
        />
        <WalletPicker
          open={s.walletPickerOpen}
          wallets={s.availableWallets}
          recentWallet={s.recentWallet}
          onPick={(walletId) => void s.onPickWallet(walletId)}
          onClose={s.onCloseWalletPicker}
        />
        <Rail markets={s.markets} asset={s.asset} loading={s.marketsLoading} onPick={s.setAsset} />
        <Tape deck={s.deck} now={now} />

        {/*
          The statistics strip and the Maker Depth chart (issue #28). Unfiltered by
          direction and by expiry on purpose -- see `DepthChart.tsx` -- so it sits here,
          outside every branch below it, and keeps orienting a Trader through a VETO or
          an empty Deck rather than disappearing with them.

          Issue #32: `depth` itself is never cleared for a switch (see `depthLoading` in
          `lib/surface.ts`), so the chart on screen is the stale one until the fresh read
          lands -- `depth-refreshing` says so in place, rather than the chart winking out
          and back in on every Underlying pick. Only the very first read, before there is
          anything to show at all, gets the full-width note below it.
        */}
        {s.depth ? (
          <>
            {s.depthLoading ? (
              <p className="loading refresh" role="status" data-testid="depth-refreshing">
                Updating the depth chart…
              </p>
            ) : s.depthError ? (
              <p className="loading refresh" role="alert" data-testid="depth-stale-error">
                {s.depthError} Showing the last read.
              </p>
            ) : null}
            <DepthChart depth={s.depth} horizonDays={s.horizonDays} horizonLabel={horizonLabel} />
          </>
        ) : s.depthLoading ? (
          <p className="loading" role="status" data-testid="depth-loading">
            Reading the depth chart…
          </p>
        ) : s.depthError ? (
          <p className="loading" role="alert" data-testid="depth-error">
            {s.depthError}
          </p>
        ) : null}

        {/*
          Issue #32 verified this branch, rather than rebuilding it: a VETO replaces
          everything below it -- the Deck, the confirmation, the RFQ door's own trigger
          in the chips row -- with `VetoScreen`, which is `role="alert"` and carries its
          own "Nothing was signed" banner (`journeys.spec.ts`, "the halt states"). Rail,
          Tape and the Maker Depth chart above stay up, on purpose and unchanged from
          issue #28: they are the book's own standing state, not "a live Deck" in the
          sense the ticket means -- nothing there is a proposal a Trader could act on,
          nothing there can be confirmed, and losing them on every Veto would strand a
          Trader with no way back to a market they were just looking at.
        */}
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
            onRfq={s.openRfq}
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
                    onOpenRfq={s.openRfq}
                  />

                  {proposal ? (
                    <span className={`tag${proposal.chosenBy === "TRADER" ? " mine" : ""}`} data-testid="chosen-by">
                      <i aria-hidden="true" />
                      {proposal.chosenBy === "TRADER" ? "your pick, not the agent's" : "the agent picked this"}
                    </span>
                  ) : null}
                </div>

                {/*
                  Issue #32: the two branches below used to be swapped -- `deckError` was
                  checked before `deck`, so a transient failure on the background poll
                  replaced a perfectly good, still-tradeable stale Deck with a bare error
                  paragraph. Now `deck` wins whenever there is one: a stale Deck is a
                  Deck, and the loading/error state becomes a small in-place note over it
                  rather than a takeover. Only the FIRST read, before there is anything
                  to show, still gets the full paragraph.

                  `busy={s.busy || s.loading}` is the fix for the actual bug this ticket
                  found: without it, the stale Deck's Cards stayed clickable while a
                  switch was in flight, and a click sent the NEW `asset` alongside a
                  `cardRef` that only exists on the OLD one.
                */}
                {s.deck ? (
                  <>
                    {s.loading ? (
                      <p className="loading refresh" role="status" data-testid="deck-refreshing">
                        Updating the book…
                      </p>
                    ) : s.deckError ? (
                      <p className="loading refresh" role="alert" data-testid="deck-stale-error">
                        {s.deckError} Showing the last book we read.
                      </p>
                    ) : null}
                    <DeckRow
                      deck={s.deck}
                      selectedRef={s.selectedRef}
                      dealtRef={s.dealtRef}
                      busy={s.busy || s.loading}
                      now={now}
                      onPick={(ref) => void s.pick(ref)}
                    />
                  </>
                ) : s.loading ? (
                  <p className="loading" role="status" data-testid="deck-loading">
                    Reading the book…
                  </p>
                ) : s.deckError ? (
                  <p className="loading" role="alert" data-testid="deck-error">
                    {s.deckError}
                  </p>
                ) : null}
              </section>

              {/*
                Issue #32: the board reads across all SIX Underlyings, not scoped to
                whichever one the rail has selected. This matches `GET /positions`
                itself (`apps/api/src/app.ts`) -- it takes no `asset` parameter and
                already prices every Underlying's spot in one read (`holdings.ts`'s
                comment on why a single "the spot" was wrong for a multi-asset board) --
                so there is no server-side per-asset endpoint to scope this against
                without adding one for no reason: a Trader holding a BTC option while
                looking at the SOL market must still see it, not lose it behind a filter
                the rail was never meant to apply to their own money.
              */}
              <section className="sect" aria-label="What you hold">
                <span className="lbl">Yours</span>
                <Board holdings={s.board?.holdings ?? []} now={now} loading={s.boardLoading} />
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

        {/*
          Issue #31 -- mounted outside the branch above, deliberately: the RFQ door
          opens this from the chips row (the normal Deck) AND from the empty-Deck
          message (a different branch entirely), so it cannot live inside either one.
        */}
        <RfqModal
          open={s.rfqOpen}
          asset={s.asset}
          direction={s.direction}
          spot={s.deck?.spotUsd ?? null}
          offsetPct={s.rfqOffsetPct}
          horizonDays={s.rfqHorizonDays}
          sizeUsdc={s.rfqSizeUsdc}
          session={s.session}
          busy={s.rfqBusy}
          refusal={s.rfqRefusal}
          onOffsetCommit={s.setRfqOffset}
          onTenor={s.setRfqTenor}
          onResize={s.setRfqSize}
          onSubmit={() => void s.submitRfq()}
          onClose={s.closeRfq}
        />
      </div>
    </main>
  );
}
