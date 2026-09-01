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
import type { ExpiryOption, Figure, UnderlyingSymbol } from "@copilot/shared";
import {
  ApiRefusal,
  fill,
  getBoard,
  getDeck,
  getMarkets,
  getSession,
  practice,
  propose,
  type Board,
  type Card,
  type Deck,
  type FillReceipt,
  type MarketRow,
  type ProposeResult,
  type SessionState,
} from "./api";

/** Trades of 1-2 USDC are normal and expected for this product. */
export const STAKE_USDC = 2;

/** The tape has to look alive without hammering a route that reads the chain. */
const DECK_POLL_MS = 6000;

export type Direction = "UP" | "DOWN";

/**
 * The Underlying the surface opens on.
 *
 * ETH because it is the deepest book. NOT a fallback: every request names an asset, and
 * this is simply which one is selected before the Trader has picked.
 */
export const DEFAULT_ASSET: UnderlyingSymbol = "ETH";

/**
 * Which expiry to open on: the one with the MOST Cards, not the shortest.
 *
 * One day is routinely the emptiest cell in the whole book -- on a recent snapshot ETH
 * puts at one day were a single Card against nine at four days -- so opening on the
 * shortest expiry makes a Trader's first impression of the market a nearly empty row.
 * Ties go to the nearer expiry, which is the only tiebreak that does not reorder the
 * surface as depth wobbles between two equal chips.
 *
 * Returns null when nothing is live, which is a real state: no Underlying quotes a put
 * beyond three days, and a direction can have no live expiry at all.
 */
export function fullestExpiry(expiries: ExpiryOption[]): number | null {
  const live = expiries.filter((e) => e.live);
  if (!live.length) return null;
  return live.reduce((best, e) => (e.cards > best.cards ? e : best), live[0]!).horizonDays;
}

export interface ChatLine {
  // The Copilot, never a "bot" -- CONTEXT.md keeps "trading bot" off the agents, and
  // the thing speaking on the left is the Copilot itself.
  who: "trader" | "copilot";
  text: string;
}

export type GateState = "idle" | "pass" | "wait" | "fail";

export interface Surface {
  asset: UnderlyingSymbol;
  /** Every market that is quoting, for the rail. Empty until the first answer lands. */
  markets: MarketRow[];
  direction: Direction;
  horizonDays: number;
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

  setAsset: (a: UnderlyingSymbol) => void;
  setDirection: (d: Direction) => void;
  setHorizon: (h: number) => void;
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
  const [asset, setAssetState] = useState<UnderlyingSymbol>(DEFAULT_ASSET);
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [direction, setDirectionState] = useState<Direction>("DOWN");
  const [horizonDays, setHorizonState] = useState<number>(1);
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

  const say = useCallback((text: string) => setLog((l) => [...l, { who: "copilot", text }]), []);
  const heard = useCallback((text: string) => setLog((l) => [...l, { who: "trader", text }]), []);

  const refreshMoney = useCallback(async () => {
    const [s, b] = await Promise.all([getSession().catch(() => null), getBoard().catch(() => null)]);
    if (s) setSession(s);
    if (b) setBoard(b);
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
    async (a: UnderlyingSymbol, d: Direction, h: number, { spinner = false } = {}): Promise<Deck | null> => {
      if (spinner) setLoading(true);
      try {
        const next = await getDeck({ asset: a, direction: d, horizonDays: h, sizeUsdc: STAKE_USDC });
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
    void loadDeck(asset, direction, horizonDays, { spinner: true });
  }, [asset, direction, horizonDays, loadDeck]);

  useEffect(() => {
    void refreshMoney();
  }, [refreshMoney]);

  // The rail, once. Spot moves and the Deck poll keeps the tape honest about that; the
  // set of markets and their standing depth does not move minute to minute, and polling
  // it would be six books re-read for a bar that would not visibly change.
  useEffect(() => {
    void getMarkets()
      .then((m) => setMarkets(m.markets))
      .catch(() => undefined);
  }, []);

  // The tape is only honest if it keeps asking. Cheap: /deck is read-only and local.
  useEffect(() => {
    const timer = setInterval(() => void loadDeck(asset, direction, horizonDays), DECK_POLL_MS);
    return () => clearInterval(timer);
  }, [asset, direction, horizonDays, loadDeck]);

  const clearSelection = useCallback(() => {
    setSelectedRef(null);
    setDealtRef(null);
    setResult(null);
    setQuoteMoved(false);
    setRefusal(null);
    setReceipt(null);
    shownQuote.current = { ref: null, premium: null };
  }, []);

  /**
   * Pick an Underlying. The picker is the source of truth; the chat does not drive it.
   *
   * Saying "buy me some SOL" in the Copilot panel must NOT move this -- reading an asset
   * name out of a sentence is the Trade Agent's job, and it does not exist yet (ADR-0007).
   * A regex that guessed would be a model originating a selection, which is the shape of
   * mistake ADR-0006 is about.
   */
  const setAsset = useCallback(
    (a: UnderlyingSymbol) => {
      if (a === asset) return;
      clearSelection();
      setAssetState(a);
    },
    [asset, clearSelection]
  );

  const setDirection = useCallback(
    (d: Direction) => {
      if (d === direction) return;
      clearSelection();
      setDirectionState(d);
    },
    [direction, clearSelection]
  );

  const setHorizon = useCallback(
    (h: number) => {
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
        const answer = await propose({
          underlying: asset,
          direction: asking,
          horizonDays,
          sizeUsdc: STAKE_USDC,
          cardRef,
        });
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
    [asset, direction, horizonDays]
  );

  const deal = useCallback(
    async (line?: string, switchTo?: Direction) => {
      if (line) heard(line);

      let row = deck;
      const asking = switchTo ?? direction;
      if (switchTo && switchTo !== direction) {
        clearSelection();
        setDirectionState(switchTo);
        row = await loadDeck(asset, switchTo, horizonDays, { spinner: true });
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
    [ask, asset, clearSelection, deck, direction, heard, horizonDays, loadDeck, say]
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

  /** Spends real USDC. Reached only from the Trader's own press. */
  const confirm = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    setBusy(true);
    setRefusal(null);
    try {
      const done = await fill(p.proposalId);
      say(`Bought. ${p.proposal.figures.contracts.display} contracts at ${p.proposal.figures.strike.display}, paid ${p.proposal.figures.premiumUsdc.display}.`);
      clearSelection();
      // AFTER clearSelection, which wipes it. A Trader who has just spent real money
      // and been handed no transaction to look at has been told "trust me" at exactly
      // the moment they should not have to.
      setReceipt(done);
      await refreshMoney();
    } catch (e) {
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, say, clearSelection, refreshMoney]);

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
    void loadDeck(asset, direction, horizonDays, { spinner: true });
  }, [asset, clearSelection, loadDeck, direction, horizonDays]);

  const selectedCard = deck?.cards.find((c) => c.cardRef === selectedRef) ?? null;

  return {
    asset,
    markets,
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
    setAsset,
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
