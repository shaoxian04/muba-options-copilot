"use client";

/**
 * The trading surface as one state machine.
 *
 * Everything the right-hand column shows is derived from what the server last said, and
 * every action here is a request. The hook holds no economics of its own: `result` is
 * whatever `/propose` answered, and the components render its strings.
 *
 * Two rules are enforced structurally rather than remembered:
 *
 *   - Confirm and Practice Run call two different functions on two different routes.
 *     There is no shared submit that picks an endpoint from a boolean, because that
 *     boolean is exactly the thing that fails open (see `apps/api/src/practice.ts`).
 *
 *   - A proposal is invalidated the moment the Deck under it disagrees about the price.
 *     A Trader is told before they confirm, never after.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Figure } from "@copilot/shared";
import {
  ApiRefusal,
  getBoard,
  getDeck,
  getSession,
  practice,
  prepareFill,
  propose,
  settleFill,
  type Board,
  type Card,
  type Deck,
  type FillReceipt,
  type PreparedFill,
  type ProposeResult,
  type SessionState,
} from "./api";
import { connectWallet as connectInjectedWallet, connectedAddress, sendTx } from "./wallet";

/** Trades of 1-2 USDC are normal and expected for this product. */
export const STAKE_USDC = 2;

/** The tape has to look alive without hammering a route that reads the chain. */
const DECK_POLL_MS = 6000;

export type Direction = "UP" | "DOWN";
export type Horizon = 1 | 2 | 3;

export interface ChatLine {
  // The Copilot, never a "bot" -- CONTEXT.md keeps "trading bot" off the agents, and
  // the thing speaking on the left is the Copilot itself.
  who: "trader" | "copilot";
  text: string;
}

export type GateState = "idle" | "pass" | "wait" | "fail";

export interface Surface {
  direction: Direction;
  horizonDays: Horizon;
  deck: Deck | null;
  deckError: string | null;
  loading: boolean;

  selectedRef: string | null;
  dealtRef: string | null;
  selectedCard: Card | null;
  result: ProposeResult | null;
  /** The Deck moved under a proposal the Trader has not confirmed yet. */
  quoteMoved: boolean;
  /** A sentence the server wrote, shown verbatim. Never composed here. */
  refusal: string | null;

  session: SessionState | null;
  board: Board | null;
  receipt: FillReceipt | null;
  busy: boolean;
  log: ChatLine[];

  walletAddress: string | null;
  walletConnecting: boolean;
  walletError: string | null;
  connectWallet: () => Promise<void>;

  setDirection: (d: Direction) => void;
  setHorizon: (h: Horizon) => void;
  deal: (line?: string, switchTo?: Direction) => Promise<void>;
  pick: (cardRef: string) => Promise<void>;
  confirm: () => Promise<void>;
  runPractice: () => Promise<void>;
  say: (text: string) => void;
  reset: () => void;
}

const proposalOf = (r: ProposeResult | null) => (r && r.kind === "PROPOSAL" ? r : null);

/**
 * The Max Loss to show before the Trader has picked anything.
 *
 * Only when every Card in the Deck agrees on it. `buildDeck` guarantees that -- it
 * excludes Orders too thin to take the whole stake, precisely so the commit bar can sit
 * still -- but the frontend does not assume a backend invariant it can check for free.
 * When the Deck disagrees with itself, the bar waits for a pick rather than putting a
 * figure under "Most you can lose" that belongs to an Order nobody chose.
 */
export function agreedMaxLoss(deck: Deck | null): Figure | null {
  if (!deck?.cards.length) return null;
  const distinct = new Set(deck.cards.map((c) => c.maxLossUsdc.display));
  return distinct.size === 1 ? deck.cards[0]!.maxLossUsdc : null;
}

/**
 * The three chips: Trade Agent, Review Agent, and the Trader.
 *
 * Derived here rather than in the page so the one rule that matters is stated once --
 * the human is always last, and the Review Agent never reads as "approved". It has no
 * such power (ADR-0006); a pass from it means only that it did not veto.
 *
 * There is deliberately no VETO case. A Veto replaces the whole surface with its own
 * screen, commit bar included, because a halt rendered as one red chip beside a live
 * Deck is a halt a Trader scrolls past. Handling it here would be a branch that can
 * never run.
 */
export function agentGate(result: ProposeResult | null): Array<{ label: string; state: GateState }> {
  const proposal = proposalOf(result)?.proposal;
  if (!proposal)
    return [
      { label: "Trade Agent", state: "idle" },
      { label: "Review Agent", state: "idle" },
      { label: "You", state: "idle" },
    ];

  return [
    { label: "Trade Agent", state: "pass" },
    // An override is not the Review Agent being skipped. It ran, it did not veto, and
    // the Trader chose a different Card -- which the chip says out loud, so
    // responsibility for the choice is never ambiguous.
    { label: proposal.chosenBy === "TRADER" ? "Review · your override" : "Review Agent", state: "pass" },
    { label: "You", state: "wait" },
  ];
}

export function useSurface(): Surface {
  const [direction, setDirectionState] = useState<Direction>("DOWN");
  const [horizonDays, setHorizonState] = useState<Horizon>(1);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [dealtRef, setDealtRef] = useState<string | null>(null);
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [quoteMoved, setQuoteMoved] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const [session, setSession] = useState<SessionState | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [receipt, setReceipt] = useState<FillReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<ChatLine[]>([]);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const say = useCallback((text: string) => setLog((l) => [...l, { who: "copilot", text }]), []);
  const heard = useCallback((text: string) => setLog((l) => [...l, { who: "trader", text }]), []);

  const refreshMoney = useCallback(async () => {
    const [s, b] = await Promise.all([getSession().catch(() => null), getBoard(walletAddress).catch(() => null)]);
    if (s) setSession(s);
    if (b) setBoard(b);
  }, [walletAddress]);

  // First paint: pick up a wallet the browser already authorised, without prompting.
  useEffect(() => {
    void connectedAddress().then(setWalletAddress);
  }, []);

  const connectWallet = useCallback(async () => {
    setWalletConnecting(true);
    setWalletError(null);
    try {
      setWalletAddress(await connectInjectedWallet());
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : "Could not connect a wallet.");
    } finally {
      setWalletConnecting(false);
    }
  }, []);

  /**
   * The current proposal, against the Deck as it stands now.
   *
   * Comparing the strings rather than the values is deliberate: the Trader was shown a
   * string, and "the price moved" means the string they would read has changed. Two
   * values that differ in the seventh decimal are not a moved quote.
   */
  const shownQuote = useRef<{ ref: string | null; premium: string | null }>({ ref: null, premium: null });

  const loadDeck = useCallback(
    async (d: Direction, h: Horizon, { spinner = false } = {}): Promise<Deck | null> => {
      if (spinner) setLoading(true);
      try {
        const next = await getDeck({ direction: d, horizonDays: h, sizeUsdc: STAKE_USDC });
        setDeck(next);
        setDeckError(null);

        const { ref, premium } = shownQuote.current;
        if (ref && premium !== null) {
          const card = next.cards.find((c) => c.cardRef === ref);
          setQuoteMoved(!card || card.premiumUsdc.display !== premium);
        }
        return next;
      } catch (e) {
        setDeckError(e instanceof Error ? e.message : "The Deck could not be read.");
        return null;
      } finally {
        if (spinner) setLoading(false);
      }
    },
    []
  );

  // First paint, and whenever the Trader changes what they are looking at.
  useEffect(() => {
    void loadDeck(direction, horizonDays, { spinner: true });
  }, [direction, horizonDays, loadDeck]);

  useEffect(() => {
    void refreshMoney();
  }, [refreshMoney]);

  // The tape is only honest if it keeps asking. Cheap: /deck is read-only and local.
  useEffect(() => {
    const timer = setInterval(() => void loadDeck(direction, horizonDays), DECK_POLL_MS);
    return () => clearInterval(timer);
  }, [direction, horizonDays, loadDeck]);

  const clearSelection = useCallback(() => {
    setSelectedRef(null);
    setDealtRef(null);
    setResult(null);
    setQuoteMoved(false);
    setRefusal(null);
    setReceipt(null);
    shownQuote.current = { ref: null, premium: null };
  }, []);

  const setDirection = useCallback(
    (d: Direction) => {
      if (d === direction) return;
      clearSelection();
      setDirectionState(d);
    },
    [direction, clearSelection]
  );

  const setHorizon = useCallback(
    (h: Horizon) => {
      if (h === horizonDays) return;
      clearSelection();
      setHorizonState(h);
    },
    [horizonDays, clearSelection]
  );

  /**
   * Ask the server for a trade and hang the surface off its answer.
   *
   * `cardRef` present means the Trader overruled the agent. The distinction is not made
   * here -- the server answers with `chosenBy`, and the surface marks what it is told.
   */
  const ask = useCallback(
    async (cardRef: string | undefined, asking: Direction = direction) => {
      setBusy(true);
      setRefusal(null);
      setReceipt(null);
      try {
        const answer = await propose({ direction: asking, horizonDays, sizeUsdc: STAKE_USDC, cardRef });
        setResult(answer);
        setQuoteMoved(false);

        if (answer.kind === "PROPOSAL") {
          setSelectedRef(answer.cardRef);
          if (answer.proposal.chosenBy === "AGENT") setDealtRef(answer.cardRef);
          shownQuote.current = { ref: answer.cardRef, premium: answer.proposal.figures.premiumUsdc.display };
        } else {
          shownQuote.current = { ref: null, premium: null };
        }
        return answer;
      } catch (e) {
        if (e instanceof ApiRefusal) {
          setRefusal(e.message);
          setResult(null);
          shownQuote.current = { ref: null, premium: null };
          return null;
        }
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [direction, horizonDays]
  );

  const deal = useCallback(
    async (line?: string, switchTo?: Direction) => {
      if (line) heard(line);

      let row = deck;
      const asking = switchTo ?? direction;
      if (switchTo && switchTo !== direction) {
        clearSelection();
        setDirectionState(switchTo);
        row = await loadDeck(switchTo, horizonDays, { spinner: true });
      }

      const answer = await ask(undefined, asking);
      if (answer?.kind === "PROPOSAL") {
        const f = answer.proposal.figures;
        const card = row?.cards.find((c) => c.cardRef === answer.cardRef);
        say(
          `Dealt the ${f.strike.display} — ${card ? `${card.impliedChance.display} chance, ${card.chanceLabel}, ` : ""}` +
            `${f.contracts.display} contracts for ${f.premiumUsdc.display}. Ends ${f.expiry.display}. ` +
            `Flick to another if you disagree with me.`
        );
      } else if (answer?.kind === "NO_ORDER") {
        say(answer.message);
      }
    },
    [ask, clearSelection, deck, direction, heard, horizonDays, loadDeck, say]
  );

  const pick = useCallback(
    async (cardRef: string) => {
      if (busy) return;
      const answer = await ask(cardRef);
      if (answer?.kind === "PROPOSAL" && answer.proposal.chosenBy === "TRADER") {
        const f = answer.proposal.figures;
        say(`Your pick: ${f.strike.display}, ${f.contracts.display} contracts for ${f.premiumUsdc.display}. Same checks either way.`);
      }
    },
    [ask, busy, say]
  );

  /** Spends real USDC, signed by the Trader's own connected wallet (ADR-0009). */
  const confirm = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    if (!walletAddress) {
      setRefusal("Connect a wallet first — Confirm needs a signature from your own wallet.");
      return;
    }
    setBusy(true);
    setRefusal(null);
    let prepared: PreparedFill | null = null;
    try {
      prepared = await prepareFill(p.proposalId, walletAddress);
      if (prepared.approveTx) await sendTx(prepared.approveTx);
      const txHash = await sendTx(prepared.fillTx);
      await settleFill(p.proposalId, { succeeded: true, txHash });

      say(`Bought. ${p.proposal.figures.contracts.display} contracts at ${p.proposal.figures.strike.display}, paid ${p.proposal.figures.premiumUsdc.display}.`);
      clearSelection();
      // AFTER clearSelection, which wipes it. A Trader who has just spent real money
      // and been handed no transaction to look at has been told "trust me" at exactly
      // the moment they should not have to.
      setReceipt({ txHash, optionAddress: prepared.optionAddress, explorerUrl: `${prepared.explorerTxUrlBase}${txHash}` });
      await refreshMoney();
    } catch (e) {
      // Only settle(false) if prepare actually succeeded -- there is nothing to release
      // if the reservation was never made. /fill/prepare reserves the Risk Budget
      // synchronously on the server the moment it runs, so the display has to catch up
      // here too -- not just on the success path -- or a Trader sees a budget that
      // still looks untouched while a reservation sits released behind it.
      if (prepared) {
        await settleFill(p.proposalId, { succeeded: false }).catch(() => {});
        await refreshMoney();
      }
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else setRefusal(e instanceof Error ? e.message : "The wallet could not complete this fill.");
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, walletAddress, say, clearSelection, refreshMoney]);

  /** Opens a simulated Position. A different function, on a different route. */
  const runPractice = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    setBusy(true);
    setRefusal(null);
    try {
      await practice(p.proposalId);
      say(
        `Practice run open — no money moved. ${p.proposal.figures.contracts.display} contracts at ` +
          `${p.proposal.figures.strike.display}, and it would have cost ${p.proposal.figures.premiumUsdc.display}.`
      );
      clearSelection();
      await refreshMoney();
    } catch (e) {
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, say, clearSelection, refreshMoney]);

  const reset = useCallback(() => {
    clearSelection();
    void loadDeck(direction, horizonDays, { spinner: true });
  }, [clearSelection, loadDeck, direction, horizonDays]);

  const selectedCard = deck?.cards.find((c) => c.cardRef === selectedRef) ?? null;

  return {
    direction,
    horizonDays,
    deck,
    deckError,
    loading,
    selectedRef,
    dealtRef,
    selectedCard,
    result,
    quoteMoved,
    refusal,
    session,
    board,
    receipt,
    busy,
    log,
    walletAddress,
    walletConnecting,
    walletError,
    connectWallet,
    setDirection,
    setHorizon,
    deal,
    pick,
    confirm,
    runPractice,
    say,
    reset,
  };
}

/**
 * A ticking clock, shared by every countdown on the surface.
 *
 * One interval rather than one per holding: a board with six holdings should not mean
 * six timers drifting apart from each other.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
