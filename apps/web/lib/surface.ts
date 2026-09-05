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
import type {
  ExpiryOption, Figure, PreparedRfq, PreparedRfqSettle, RfqStatus, RfqTenorDays, UnderlyingSymbol,
} from "@copilot/shared";
import {
  ApiRefusal,
  getBoard,
  getDeck,
  getDepth,
  getMarkets,
  getSession,
  practice,
  prepareFill,
  propose,
  proposeChat,
  requestAuthChallenge,
  requestRfq,
  confirmRfq,
  getRfqStatus,
  prepareRfqSettle,
  settleRfq,
  prepareRfqCancel,
  cancelRfq,
  settleFill,
  verifyAuthChallenge,
  type Board,
  type Card,
  type Deck,
  type DepthView,
  type FillReceipt,
  type MarketRow,
  type PreparedFill,
  type ProposeResult,
  type SessionState,
} from "./api";
import {
  connectedAddress,
  connectWallet as connectWalletById,
  disconnectWallet as disconnectWalletById,
  lastConnectedWalletId,
  listAvailableWallets,
  recentConnectionWithinTtl,
  sendTx,
  setWalletMemoryScope,
  WalletConnectionCancelled,
  signMessage,
  walletOptionFor,
  watchAvailableWallets,
  type WalletOption,
} from "./wallet";
import { clampSizeUsdc, rfqSizeCapUsdc } from "./geometry";
import { confirmWithRetry, shouldReleaseReservation, RFQ_STRANDED_MESSAGE } from "./rfqSubmit";
import { DECK_POLL_MS, RFQ_POLL_MS, pollWhileVisible, beginLatestOnly, isLatest, endLatestOnly } from "./polling";

// Re-exported so every existing importer of these from `surface` keeps working. They
// live in `polling.ts` now: the intervals, the hidden-tab rule and "latest wins" are one
// concern, and they were sitting in the middle of a file that is mostly one large hook.
export { DECK_POLL_MS, RFQ_POLL_MS, pollWhileVisible, beginLatestOnly, isLatest, endLatestOnly } from "./polling";
import { supabase } from "./supabaseClient";
import { STAKE_USDC } from "./constants";

export { STAKE_USDC };

/**
 * The confirmation's size presets (issue #30) -- fixed USDC amounts a Trader reaches a
 * normal stake with in one click, plus the label already formatted as currency.
 *
 * Defined here rather than in the modal component because `label` carries a literal
 * "$", and `components/` and `app/` may not: `tests/support/no-arithmetic.test.ts`
 * greps every one of those files for a bare "$", on the rule that a component typing
 * out how money looks is the same mistake as a component computing what the number is.
 * These are not server Figures -- they are the four fixed choices the control offers,
 * chosen before any pricing happens -- but the string still has to live off that list.
 */
export interface SizePreset {
  usdc: number;
  label: string;
}
export const SIZE_PRESETS_USDC: SizePreset[] = [
  { usdc: 1, label: "$1" },
  { usdc: 2, label: "$2" },
  { usdc: 5, label: "$5" },
  { usdc: 10, label: "$10" },
];

/** The stepper's floor and its step, in USDC. */
export const SIZE_MIN_USDC = 0.5;
export const SIZE_STEP_USDC = 0.5;

/**
 * The RFQ door's strike slider (issue #31): how far either side of spot it reaches,
 * and its step. Both in percent -- the slider never trades in dollars, because there
 * is no dollar strike anywhere until the server derives one for the refusal's own
 * echoed sentence.
 */
export const RFQ_STRIKE_BAND_PCT = 30;
export const RFQ_STRIKE_STEP_PCT = 0.5;

/**
 * The RFQ's tenor grid. Mirrors `RFQ_TENOR_DAYS` in `@copilot/shared` exactly --
 * `rfq.test.ts` (API) and this file cannot silently drift, because both are four
 * literal numbers, not a derivation.
 *
 * Duplicated rather than imported as a VALUE from the shared package on purpose.
 * Every existing import of `@copilot/shared` from `apps/web` is `import type`, which
 * TypeScript erases before webpack ever sees it; pulling in a real export here would
 * be the first runtime import of that package's `index.ts` from the client bundle,
 * and Next's webpack cannot resolve the `.js`-suffixed `export * from "./forecast.js"`
 * partway down that file outside a `moduleResolution: bundler` typecheck -- a build
 * that fails at `next build`, not at `tsc`. Keeping this literal here sidesteps a
 * webpack config change under this ticket, and as a side effect keeps ADR-0005's
 * quarantine airtight: no code path exists by which `forecast.ts` could ever reach
 * the client bundle at all.
 */
export const RFQ_TENOR_DAYS: readonly RfqTenorDays[] = [7, 14, 30, 60];





export type Direction = "UP" | "DOWN";

/**
 * A full Trade Intent -- what a Suggestion carries, and what `deal` accepts instead of
 * just a direction. Every field is optional on the way in: whatever is omitted holds at
 * its current value, so a caller that only wants to flip direction does not have to
 * restate the size and horizon it did not mean to touch.
 *
 * Deliberately shaped like `TradeIntent` in `@copilot/shared` (this is the browser's
 * partial view of the same thing) but with `horizonDays: number`, because the surface
 * takes its expiries from the live book rather than a fixed grid.
 */
export interface TradeIntent {
  underlying: UnderlyingSymbol;
  direction: Direction;
  sizeUsdc: number;
  horizonDays: number;
}

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

/**
 * One turn in the Trade transcript.
 *
 * A discriminated union rather than a bare string, because the panel now emits two
 * different things and only one of them is prose. `say()` melting a server `Figure`
 * into a sentence -- `${f.strike.display}, ${f.contracts.display} contracts for
 * ${f.premiumUsdc.display}` -- threw away the structure the server had just gone to the
 * trouble of building, and left a Review Agent veto rendering identically to small talk.
 * Keeping the `Figure`s intact is ADR-0006 held onto for one step longer, not loosened:
 * every string below is still the server's own `display`, never rebuilt here.
 *
 * The log carries ONLY what answers something the Trader submitted. A Card click, an
 * accepted Suggestion and a Practice Run used to narrate themselves in here; they say
 * nothing now, because each is already visible where it happened -- the Deck highlights
 * the Card, the confirmation opens, and the practice receipt renders inside it.
 */
export type ChatLine =
  // The Copilot, never a "bot" -- CONTEXT.md keeps "trading bot" off the agents, and
  // the thing speaking on the left is the Copilot itself.
  | { who: "trader" | "copilot"; kind?: "text"; text: string }
  /**
   * An Order the Trade Agent named in answer to a typed sentence, rendered as a Card
   * with its own "Place order" button. The button re-enters `pick(cardRef)` -- the same
   * door a Deck Card click uses -- so the Order is re-fetched and re-priced server-side
   * before any confirmation opens. Nothing here is ever the number that gets filled.
   */
  | {
      who: "copilot";
      kind: "proposal";
      cardRef: string;
      underlying: UnderlyingSymbol;
      direction: Direction;
      horizonDays: number;
      strike: Figure;
      premiumUsdc: Figure;
      expiry: Figure;
      /**
       * Implied Chance is deliberately NOT carried here. It belongs to the Card, not to
       * the proposal, and the Deck that holds it refreshes underneath this log -- a
       * value copied in at answer time would be a number that was true once. The
       * renderer looks it up live by `cardRef` instead (`chanceFor` in page.tsx), and
       * renders the Card without one when the Order sits in an expiry not on screen.
       */
    };

export type GateState = "idle" | "pass" | "wait" | "fail";

export interface Surface {
  asset: UnderlyingSymbol;
  /** Every market that is quoting, for the rail. Empty until the first answer lands. */
  markets: MarketRow[];
  /**
   * Issue #32: true only until `GET /markets` answers ONCE -- the rail is fetched a
   * single time (see the effect below), so there is no "refreshing" state to draw for
   * it the way the Deck and the Depth chart have, only a first read to wait out.
   */
  marketsLoading: boolean;
  direction: Direction;
  horizonDays: number;
  deck: Deck | null;
  deckError: string | null;
  /**
   * True whenever a Deck request the Trader is WAITING on is in flight -- the first
   * paint, an Underlying/direction/horizon switch, or a `reset()`. NOT true for the
   * background poll that keeps the tape honest (`loadDeck` without `{ spinner: true }`),
   * because that one is not something a Trader is watching a spinner for.
   *
   * Issue #32: `deck` itself is never cleared while this is true -- the stale Deck stays
   * on screen and `page.tsx` draws a small "Updating…" note over it rather than blanking
   * the section, which is what "an Underlying switch does not blank the whole surface"
   * means in practice. The one place this flag DOES change behaviour is `DeckRow`'s
   * `busy` prop: a Card from the Underlying being replaced must not be clickable while
   * the request in flight is for a DIFFERENT Underlying, or a click sends the new
   * `asset` alongside a `cardRef` that belongs to the old one.
   */
  loading: boolean;

  /**
   * Where makers will actually trade on this Underlying -- the Maker Depth chart's
   * data. Fetched by `asset` and `horizonDays` only, deliberately: it is NOT re-fetched
   * on a direction change, because the chart is unfiltered by direction (issue #28) and
   * a direction-keyed effect would re-poll it for a question the chart does not answer.
   */
  depth: DepthView | null;
  depthError: string | null;
  /**
   * Issue #32: the same `spinner`-gated meaning `loading` has for the Deck above --
   * true for the fetch a Trader is waiting on (first paint, an asset/horizon switch),
   * not for the background poll. `depth` is never cleared while this is true either;
   * `page.tsx` overlays a non-blocking note on the stale chart instead.
   */
  depthLoading: boolean;

  selectedRef: string | null;
  dealtRef: string | null;
  selectedCard: Card | null;
  result: ProposeResult | null;
  /**
   * The Deck moved under a proposal the Trader has not confirmed yet. True only for the
   * brief window before the auto-refresh below re-prices the same Order -- Confirm and
   * Practice Run both still refuse to act while this is true, so a stale number is never
   * reachable even mid-refresh.
   */
  quoteMoved: boolean;
  /**
   * A refresh just replaced the numbers on screen with a fresh price for the same Order
   * (still the Trader's own pick, never a different one) -- shown for a few seconds so a
   * Trader who glanced away notices the number changed, then clears on its own. Never
   * true at the same time as `quoteMoved`.
   */
  quoteRefreshed: boolean;
  /** A sentence the server wrote, shown verbatim. Never composed here. */
  refusal: string | null;

  /**
   * Whether the confirmation is open (issue #30). The only Confirm in the product
   * lives inside it -- there is no more persistent commit bar to fall back on, so a
   * Trader who has not clicked a Card has nothing pressable anywhere on the surface.
   */
  confirmOpen: boolean;
  /**
   * The stake the confirmation is currently priced at, in USDC. Never rendered
   * directly -- every figure the modal shows is the server's own `Figure` from the
   * latest `/propose` answer, re-fetched against the same `cardRef` whenever this
   * changes. This is the request parameter, not a figure a Trader reads.
   */
  sizeUsdc: number;
  /** A Practice Run opened for the confirmation currently on screen. */
  practiceDone: boolean;

  /**
   * Whether the RFQ door's dialog is open (issue #31). Two openers share it -- the
   * door beside the direction and expiry chips, and the empty-Deck message's own
   * button -- so an empty market is a next step rather than a dead end.
   */
  rfqOpen: boolean;
  /**
   * The strike slider's committed offset from spot, signed, in percent. Set on the
   * slider's release, never its drag -- and never resolved to a dollar strike
   * anywhere in the browser. Only the server may do that arithmetic, and only inside
   * the 501 refusal's own echoed sentence.
   */
  rfqOffsetPct: number;
  rfqHorizonDays: RfqTenorDays;
  /** The RFQ's own stake. Shares `SIZE_PRESETS_USDC`/`SIZE_MIN_USDC` with the Card confirmation, capped differently (`rfqSizeCapUsdc`) because there is no Maker Depth yet to bind against. */
  rfqSizeUsdc: number;
  rfqBusy: boolean;
  /**
   * A refusal the Trader is meant to read: the Risk Budget saying no, a wallet that has
   * not been verified, or a market with no price. Shown verbatim -- never composed here.
   */
  rfqRefusal: string | null;
  /**
   * The live request, once one has been opened on-chain (ADR-0017). Null before that and
   * after the dialog is dismissed. Everything the dialog renders about the wait comes off
   * this -- the phase, the offer count, the premium once a maker answers -- and every
   * figure on it is a string the server already formatted.
   */
  rfqStatus: RfqStatus | null;
  /**
   * The premium a maker has actually offered, once the second confirmation has been
   * prepared. Distinct from `rfqStatus.premiumUsdc` on purpose: this one is attached to
   * the settle transaction sitting in `rfqSettle`, so what the Trader reads and what the
   * chain will charge are the same number by construction.
   */
  rfqSettle: PreparedRfqSettle | null;
  /** The Fill-shaped receipt for a settled request. Null until the option exists. */
  rfqReceipt: FillReceipt | null;

  session: SessionState | null;
  board: Board | null;
  /**
   * Issue #32: true only until `GET /positions` answers for the FIRST time. The board
   * degrades to "Nothing open yet" once it has, and stays there -- a Trader who has just
   * confirmed a Fill or a Practice Run should see their existing rows update in place,
   * not the whole board blank out to a loading message while `/positions` is re-read.
   */
  boardLoading: boolean;
  receipt: FillReceipt | null;
  busy: boolean;
  log: ChatLine[];

  /** The signed-in account, if any (ADR-0014). Null means: browsing anonymously. */
  account: { userId: string; email: string; avatarUrl: string | null } | null;
  signOut: () => void;
  walletAddress: string | null;
  walletConnecting: boolean;
  walletVerified: boolean;
  walletVerifying: boolean;
  walletError: string | null;
  walletPickerOpen: boolean;
  availableWallets: WalletOption[];
  recentWallet: WalletOption | null;
  onOpenWalletPicker: () => void;
  onCloseWalletPicker: () => void;
  /** `fresh`: force a new WalletConnect pairing rather than resuming a stale session -- see `wallet.ts`'s `connectWallet`. */
  onPickWallet: (walletId: string, options?: { fresh?: boolean }) => void;
  verifyWallet: () => Promise<void>;
  onDisconnectWallet: () => void;

  setAsset: (a: UnderlyingSymbol) => void;
  setDirection: (d: Direction) => void;
  setHorizon: (h: number) => void;
  deal: (
    line?: string,
    intent?: Partial<TradeIntent>,
    opts?: { confirm?: boolean }
  ) => Promise<ProposeResult | null>;
  submitTradeMessage: (text: string) => void;
  /**
   * Clicking a Card (issue #30), or accepting an AI-matched order from
   * `NearestOrderPreview`. Opens the confirmation as well as pricing the pick. `on`
   * switches which coin/direction/expiry is selected first when given and different
   * from what's currently showing -- needed because a matched order can belong to a
   * different one than whatever the Trader currently has selected.
   */
  pick: (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => Promise<void>;
  /**
   * Re-price the SAME Order at a different stake -- what the confirmation's stepper
   * and presets call. A server round trip against the unchanged `cardRef`, exactly
   * like `pick`, so every figure the Trader reads is re-derived rather than adjusted
   * in the browser.
   */
  setSize: (usdc: number) => Promise<void>;
  /** The same size asked in contracts. Server-converted -- see `setContracts`. */
  setContracts: (count: number) => Promise<void>;
  confirm: () => Promise<void>;
  runPractice: () => Promise<void>;
  /** Escape, the backdrop, or the close button. Clears the flow; does not reload the Deck. */
  closeConfirm: () => void;

  /** Opens the RFQ dialog (issue #31), reset to sensible defaults for the current direction. */
  openRfq: () => void;
  /** The strike slider's release. Never called mid-drag -- the live value stays local to `RfqModal`. */
  setRfqOffset: (pct: number) => void;
  setRfqTenor: (days: RfqTenorDays) => void;
  /** A server round trip is neither possible nor needed here -- nothing is priced yet, so this only clamps and stores. */
  setRfqSize: (usdc: number) => void;
  /**
   * The FIRST signature: build the request and open it on-chain. Never the last -- an
   * RFQ has no price yet, and `acceptRfq` is what pays one. (ADR-0017)
   */
  submitRfq: () => Promise<void>;
  /**
   * The SECOND signature: pay a maker's own answer. Only reachable once `rfqStatus.phase`
   * is `OFFERED`, which is the only state in which a real premium exists to confirm.
   */
  acceptRfq: () => Promise<void>;
  /** Withdraw a request nobody answered, taking back the commitment to pay. */
  withdrawRfq: () => Promise<void>;
  closeRfq: () => void;

  reset: () => void;
}

const proposalOf = (r: ProposeResult | null) => (r && r.kind === "PROPOSAL" ? r : null);

/**
 * /fill/settle answers 425 when the chain hasn't shown it the transaction yet -- a
 * short-lived gap, not a failure. A few quick retries covers ordinary propagation lag
 * without asking the Trader to do anything.
 */
async function settleWithRetry(
  proposalId: string,
  txHash: string | undefined,
  attempts = 3
): Promise<{ remainingUsdc: number; confirmed: boolean }> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await settleFill(proposalId, txHash);
    } catch (e) {
      if (e instanceof ApiRefusal && e.status === 425 && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

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
  const [marketsLoading, setMarketsLoading] = useState(true);
  /**
   * Whether the Trader has picked this expiry themselves.
   *
   * False means the surface is free to move them to the fullest one when the Deck lands.
   * Cleared whenever the Underlying or the direction changes, because a horizon chosen
   * for ETH falls says nothing about which SOL rises expiry is worth opening on.
   *
   * A ref rather than state: nothing renders from it, and making it state would re-run
   * the Deck effect for a value the request does not depend on.
   */
  const expiryChosen = useRef(false);
  const [direction, setDirectionState] = useState<Direction>("DOWN");
  const [horizonDays, setHorizonState] = useState<number>(1);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [depth, setDepth] = useState<DepthView | null>(null);
  const [depthError, setDepthError] = useState<string | null>(null);
  const [depthLoading, setDepthLoading] = useState(true);

  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [dealtRef, setDealtRef] = useState<string | null>(null);
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [quoteMoved, setQuoteMoved] = useState(false);
  const [quoteRefreshed, setQuoteRefreshed] = useState(false);
  /** Clears `quoteRefreshed` a few seconds after it is set -- see the effect below. */
  const quoteRefreshedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sizeUsdc, setSizeUsdcState] = useState<number>(STAKE_USDC);
  const [practiceDone, setPracticeDone] = useState(false);

  const [rfqOpen, setRfqOpen] = useState(false);
  const [rfqOffsetPct, setRfqOffsetPctState] = useState(-10);
  const [rfqHorizonDays, setRfqHorizonDaysState] = useState<RfqTenorDays>(14);
  const [rfqSizeUsdc, setRfqSizeUsdcState] = useState<number>(STAKE_USDC);
  const [rfqBusy, setRfqBusy] = useState(false);
  const [rfqRefusal, setRfqRefusal] = useState<string | null>(null);
  const [rfqStatus, setRfqStatus] = useState<RfqStatus | null>(null);
  const [rfqSettle, setRfqSettle] = useState<PreparedRfqSettle | null>(null);
  const [rfqReceipt, setRfqReceipt] = useState<FillReceipt | null>(null);
  /**
   * The id of the live request, held in a ref rather than state.
   *
   * The polling effect below reads it, and putting it in state would restart the poll on
   * every tick that touched it. It is never rendered -- `rfqStatus` is what the dialog
   * reads -- so nothing needs a re-render when it changes.
   */
  const rfqRequestIdRef = useRef<string | null>(null);

  const [session, setSession] = useState<SessionState | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [boardLoading, setBoardLoading] = useState(true);
  const [receipt, setReceipt] = useState<FillReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<ChatLine[]>([]);

  const [account, setAccount] = useState<{ userId: string; email: string; avatarUrl: string | null } | null>(
    null
  );

  /**
   * WHICH account is signed in, as a plain string -- what the wallet effects below depend
   * on, never the `account` object itself.
   *
   * `accountFrom()` builds a fresh object on every auth event, and Supabase fires those
   * for far more than signing in and out: a token refresh, or the tab regaining focus,
   * re-emits the same account as a NEW object. Depending on that object re-ran the
   * reconnect effect at those arbitrary moments -- harmless while already connected
   * (`connect()` throws `ConnectorAlreadyConnectedError`, which the effect's own catch
   * swallows), but a genuine reconnect attempt whenever an earlier one had failed and
   * left the remembered pointer in place. For WalletConnect with a session that has since
   * died, that attempt is a pairing QR appearing out of nowhere, mid-session, on nothing
   * more than a token refresh. Keyed on the id, the same account never re-triggers either
   * effect; a genuinely different one still does.
   */
  const accountId = account?.userId ?? null;

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletVerified, setWalletVerified] = useState(false);
  const [walletVerifying, setWalletVerifying] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [availableWallets, setAvailableWallets] = useState<WalletOption[]>([]);
  const [recentWallet, setRecentWallet] = useState<WalletOption | null>(null);

  /**
   * The same "latest wins" reasoning as `beginLatestOnly`/`isLatest` below, applied to
   * wallet connects rather than Deck polls: two different things can now try to connect
   * a wallet -- the silent on-load reconnect (below) and an explicit `pickWallet` click
   * -- where before only the latter ever existed. Without this, a Trader who clicks
   * "WalletConnect" to switch wallets while the page's own silent "Last used" reconnect
   * is still resolving could see that stale attempt land afterward and overwrite their
   * deliberate choice -- exactly the bug this pattern already exists to close for /deck
   * and /depth. Every attempt claims the next number before doing anything async, and
   * only applies its result if it's still the most recent one claimed by the time it
   * resolves.
   */
  const walletConnectSeqRef = useRef(0);

  /**
   * Google puts the profile photo under `avatar_url` in Supabase's normalized
   * `user_metadata` -- `picture` is the raw OAuth claim some providers use instead,
   * kept as a fallback rather than assumed absent. Email/password sign-in has neither,
   * which is exactly when `AccountControl` falls back to an initial.
   */
  const accountFrom = (session: { user: { id: string; email?: string; user_metadata?: Record<string, unknown> } }) => ({
    userId: session.user.id,
    email: session.user.email ?? "",
    avatarUrl: (session.user.user_metadata?.avatar_url as string) ?? (session.user.user_metadata?.picture as string) ?? null,
  });

  /*
   * A Google/magic-link/email-confirmation redirect lands back here with the raw
   * session in the URL's hash fragment (`#access_token=...`) -- Supabase's client
   * reads it into `getSession()`/`onAuthStateChange` and is supposed to strip it
   * itself, but that cleanup can lag a paint behind. Stripping it explicitly, the
   * moment a session is confirmed, means it never lingers in the address bar, browser
   * history, or a screen share -- the fragment is never sent to any server either
   * way, but "never visible longer than necessary" is the safer bar to hold.
   */
  const scrubTokenFromUrl = () => {
    if (window.location.hash.includes("access_token")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  };

  // Picks up an existing sign-in on first paint, then reacts to every sign-in/sign-out
  // from then on -- including the redirect back from /login (ADR-0014).
  //
  // `setWalletMemoryScope` runs synchronously in the SAME callback as `setAccount`,
  // never in a separate effect reacting to `account` state -- that ordering is what
  // guarantees `wallet.ts`'s account-scoped storage is already pointed at the right
  // account by the time the render this triggers commits and the wallet-reconnect
  // effect below (which depends on `account`) runs. See `setWalletMemoryScope`'s own
  // comment in `wallet.ts` for why this exists: a shared device must never let a newly
  // signed-in Trader see, or silently reconnect to, the previous Trader's wallet.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setWalletMemoryScope(data.session?.user.id ?? null);
      if (data.session) setAccount(accountFrom(data.session));
      scrubTokenFromUrl();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setWalletMemoryScope(session?.user.id ?? null);
      setAccount(session ? accountFrom(session) : null);
      scrubTokenFromUrl();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(() => {
    void supabase.auth.signOut();
  }, []);

  const say = useCallback((text: string) => setLog((l) => [...l, { who: "copilot", text }]), []);
  const heard = useCallback((text: string) => setLog((l) => [...l, { who: "trader", text }]), []);
  /**
   * The Card half of an answer to a typed sentence: the Order the agent named, kept as
   * the server's own `Figure`s rather than flattened into a sentence. Paired with a
   * `say()` carrying the agent's reasoning -- the two together are one answer.
   */
  const showProposal = useCallback(
    (line: Extract<ChatLine, { kind: "proposal" }>) => setLog((l) => [...l, line]),
    []
  );


  /**
   * The board, and the Risk Budget it sits beside, together -- but only the board has
   * its own loading state (issue #32). `setBoardLoading(false)` unconditionally, on
   * every call: it only ever matters the first time (the flag starts `true` and this is
   * the only place it changes), and a Fill or a Practice Run calling this again must
   * update the rows in place rather than re-arming a loading message over them.
   */
  const refreshMoney = useCallback(async () => {
    const [s, b] = await Promise.all([getSession().catch(() => null), getBoard(walletAddress).catch(() => null)]);
    if (s) setSession(s);
    if (b) setBoard(b);
    setBoardLoading(false);
  }, [walletAddress]);

  /**
   * The half of wallet verification that's safe to run without a click: only checks
   * whether this address is already proven, via `GET /session` -- which may itself
   * report that back from `accountStore.ts`'s durable `linked_wallets` record, not just
   * this exact in-memory session (`app.ts`'s `/session` handler seeds it either way, so
   * "recently proven in another tab" and "proven in this one" read the same here).
   * Never falls through to a live challenge/sign/verify round trip on its own -- that
   * half must always follow an explicit Trader click (see `verifyWalletFor`), never a
   * silent page-load effect, or WalletConnect could push a surprise notification to a
   * Trader's phone before they have done anything at all.
   */
  const verifyIfAlreadyProven = useCallback(async (address: string): Promise<boolean> => {
    const current = await getSession().catch(() => null);
    const proven = !!current?.verifiedWallet && current.verifiedWallet.toLowerCase() === address.toLowerCase();
    if (proven) setWalletVerified(true);
    return proven;
  }, []);

  /**
   * Proves the connected wallet is who it says it is (ADR-0012) -- a text signature,
   * never a transaction. Separate from `connectWallet` so a Trader whose signature
   * request failed or was dismissed (address set, but never verified) has a "Verify
   * wallet" button to retry with one press, rather than a dead end.
   *
   * First checks whether this is already proven (`verifyIfAlreadyProven`): a refresh, a
   * new tab, or reconnecting the same wallet again doesn't need a fresh signature for
   * something already established. This reads back a proof already made -- it does not
   * loosen what counts as one -- and a different address, or nothing proven yet, falls
   * straight through to the normal challenge/sign/verify round trip.
   */
  const verifyWalletFor = useCallback(
    async (address: string) => {
      setWalletVerifying(true);
      setWalletError(null);
      try {
        if (await verifyIfAlreadyProven(address)) return;
        const { message } = await requestAuthChallenge(address);
        const signature = await signMessage(message);
        await verifyAuthChallenge(signature);
        setWalletVerified(true);
      } catch (e) {
        setWalletError(e instanceof Error ? e.message : "Could not verify this wallet.");
      } finally {
        setWalletVerifying(false);
      }
    },
    [verifyIfAlreadyProven]
  );

  /**
   * A different account than a moment ago -- signing in, switching accounts, or signing
   * all the way out -- must never keep showing a PREVIOUS Trader's wallet as connected
   * or verified. `undefined` (not `null`) marks "haven't run yet", so the very first
   * render (nothing was ever connected regardless) doesn't fire a pointless reset; every
   * actual change after that does. Ordered before the reconnect effect below,
   * deliberately: React runs one component's effects in declaration order within a
   * commit, so any stale wallet from a previous account is always cleared before this
   * account's own reconnect attempt (if any) has a chance to run.
   */
  const previousAccountIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const changed = previousAccountIdRef.current !== undefined && previousAccountIdRef.current !== accountId;
    previousAccountIdRef.current = accountId;
    if (!changed) return;
    setWalletAddress(null);
    setRecentWallet(null);
    setWalletVerified(false);
    setWalletVerifying(false);
    setWalletError(null);
  }, [accountId]);

  /**
   * Once an account is known: if a wallet was connected recently enough (a rolling
   * few-hour idle window -- `recentConnectionWithinTtl`), silently reconnect it: no
   * picker, no prompt, since the origin is already authorised and every real extension
   * answers `eth_requestAccounts` instantly in that case. This includes WalletConnect:
   * resuming its own session is a local, cached-account check backed by its own SDK's
   * persisted storage (independent of anything in this app, and it does survive a page
   * reload), not something that alone reaches a Trader's phone.
   *
   * A previous version of this comment excluded WalletConnect entirely, reasoning that
   * "resuming is only inert while a live provider instance is still in memory, and a
   * reload always destroys it" -- that conflated this app's OWN module-level connector
   * cache (`walletConnectConnectorInstance` in wallet.ts, which does reset on reload) with
   * WalletConnect's own session persistence (which doesn't, and is what "Last used" has
   * relied on this whole time). The QR that reasoning was actually chasing had a
   * different, real cause: `@wagmi/connectors`' own `isNewChainsStale` staleness check
   * forcing a fresh pairing regardless of whether a resumable session existed --
   * `wallet.ts` now disables that check outright (this app is permanently single-chain).
   * See that fix's own comment for the full story.
   *
   * The other real gap this closes: `disconnectWallet` (wallet.ts) marks the "last used"
   * entry as disconnected, and `recentConnectionWithinTtl` skips it, specifically so THIS
   * effect has nothing to retry afterward -- without that, a Trader who disconnected would
   * keep getting silently re-attempted (and, for WalletConnect, re-prompted with a pairing
   * QR every single time, since disconnecting genuinely ends the underlying session) on
   * every tab switch or reload until the TTL happened to lapse on its own. The entry is
   * marked rather than deleted so the picker below still offers that wallet as its
   * one-press "Last used" -- only the automatic path honours the flag.
   *
   * Gated on `accountId` for two reasons: ADR-0014 requires signing in before wallet
   * actions at all, and `recentConnectionWithinTtl`/`lastConnectedWalletId` now read
   * `wallet.ts`'s account-scoped storage (`setWalletMemoryScope`, set synchronously
   * alongside `setAccount` above) -- attempting this before the account is known would
   * always see empty, unscoped storage and never retry once it resolves. Depending on
   * `accountId` is what makes this effect run again the moment that scope is actually
   * set -- and, being a plain string rather than the `account` object, what keeps it
   * from re-running on every token refresh (see `accountId`'s own comment).
   *
   * Only `verifyIfAlreadyProven` runs after, deliberately, never the full
   * `verifyWalletFor`: this is a page-load effect nobody clicked, so it may only
   * confirm a proof that already exists, never request a fresh signature on its own --
   * that would mean WalletConnect could push a surprise notification to a Trader's
   * phone before they have done anything at all. An address that isn't already proven
   * just leaves `walletVerified` false, same as it would if this whole effect never
   * ran -- AccountControl's ordinary "Verify wallet" retry button covers it from there.
   *
   * Falls back to the picker-only flow whenever nothing recent exists, the remembered
   * wallet is no longer available, or the silent reconnect itself fails -- a Trader is
   * never left with no way to connect just because this shortcut didn't.
   */
  useEffect(() => {
    const showRecentWalletOption = () =>
      void lastConnectedWalletId().then((id) => setRecentWallet(id ? walletOptionFor(id) : null));

    if (!accountId) return;

    // Already connected -- adopt it rather than connect again. `/` and `/cover` each
    // mount their own `useSurface()`, so a navigation between them resets this state
    // while wagmi's own connection (a module-level singleton) is still live. See
    // `connectedAddress` for why re-connecting there doesn't just waste a round trip
    // but actively fails for WalletConnect.
    const live = connectedAddress();
    if (live) {
      setWalletAddress(live);
      void verifyIfAlreadyProven(live);
      showRecentWalletOption();
      return;
    }

    const recentId = recentConnectionWithinTtl();
    if (!recentId) {
      showRecentWalletOption();
      return;
    }
    const seq = ++walletConnectSeqRef.current;
    connectWalletById(recentId)
      .then((address) => {
        // A Trader who clicked something in the picker while this was still resolving
        // already has priority -- see `walletConnectSeqRef`'s own comment. Applying a
        // stale "Last used" result on top of their deliberate pick would be exactly the
        // "stuck on the wrong wallet" bug this guard exists to prevent.
        if (walletConnectSeqRef.current !== seq) return;
        setWalletAddress(address);
        void verifyIfAlreadyProven(address);
      })
      .catch(showRecentWalletOption);
  }, [accountId, verifyIfAlreadyProven]);

  const openWalletPicker = useCallback(() => {
    setAvailableWallets(listAvailableWallets());
    setWalletPickerOpen(true);
  }, []);

  const closeWalletPicker = useCallback(() => setWalletPickerOpen(false), []);

  // While the picker is open, extensions can still be announcing themselves (EIP-6963
  // has no guaranteed single moment "every wallet has announced by now") -- this keeps
  // the list current for as long as a Trader is looking at it.
  useEffect(() => {
    if (!walletPickerOpen) return;
    return watchAvailableWallets(setAvailableWallets);
  }, [walletPickerOpen]);

  const pickWallet = useCallback(
    async (walletId: string, options?: { fresh?: boolean }) => {
      // Claimed before anything async, so an explicit pick always outranks whatever
      // came before it -- the silent on-load reconnect included. See
      // `walletConnectSeqRef`'s own comment for the failure this closes.
      const seq = ++walletConnectSeqRef.current;
      setWalletPickerOpen(false);
      setWalletConnecting(true);
      setWalletError(null);
      setWalletVerified(false);
      try {
        const address = await connectWalletById(walletId, options);
        if (walletConnectSeqRef.current !== seq) return; // superseded by a newer pick
        setWalletAddress(address);
        await verifyWalletFor(address);
      } catch (e) {
        if (walletConnectSeqRef.current !== seq) return;
        // A Trader closing the wallet's own connect/QR dialog is a plain cancel, not a
        // failure worth an error banner -- surfacing viem's raw rejection message here
        // would read as a scary, jargon-filled error for what was just a closed dialog.
        if (e instanceof WalletConnectionCancelled) return;
        setWalletError(e instanceof Error ? e.message : "Could not connect a wallet.");
      } finally {
        // A superseded attempt must not clear the flag a newer, still-running one set.
        if (walletConnectSeqRef.current === seq) setWalletConnecting(false);
      }
    },
    [verifyWalletFor]
  );

  /**
   * Lets a Trader manually forget the connected wallet -- e.g. after revoking the dApp
   * on the wallet's own side -- rather than being stuck showing a stale address the
   * wallet itself no longer recognises. Resets every piece of wallet state back to
   * "nothing connected," the same starting point as a fresh page load.
   */
  const disconnectWallet = useCallback(async () => {
    await disconnectWalletById();
    setWalletAddress(null);
    setWalletVerified(false);
    setWalletVerifying(false);
    setWalletError(null);
  }, []);

  /**
   * The current proposal, against the Deck as it stands now.
   *
   * Comparing the strings rather than the values is deliberate: the Trader was shown a
   * string, and "the price moved" means the string they would read has changed. Two
   * values that differ in the seventh decimal are not a moved quote.
   *
   * The string compared is the PER-CONTRACT price, never the total premium. The total is
   * a function of the stake as well as the market -- a $5 stake buys about $5 of premium
   * and a $2 stake about $2 -- while this background poll always prices the Deck at
   * `STAKE_USDC`. Comparing totals therefore measured the stepper, not the book: the
   * instant a Trader moved the size off the default, the next tick read "$2.00" against
   * a remembered "$5.00", declared the quote moved, and disabled Confirm for good on a
   * book that had not budged. Per-contract is what actually moves with spot and vol, and
   * it means the same thing at every size.
   */
  const shownQuote = useRef<{ ref: string | null; perContract: string | null }>({ ref: null, perContract: null });

  /**
   * The Card that opened the confirmation (issue #30), so `closeConfirm` can give focus
   * back to it.
   *
   * Captured here, synchronously, in `pick()` -- not inside the modal on open. `pick()`
   * disables that same Card the instant it opens the confirmation (so a second click
   * cannot fire mid-request), and a browser blurs a focused element to `<body>` the
   * moment it goes disabled. By the time an effect inside the modal could read
   * `document.activeElement`, the opener is already gone from it; this runs one render
   * earlier, before `disabled` has reached the DOM at all.
   */
  const openerElRef = useRef<HTMLElement | null>(null);

  /** The same capture, for the RFQ dialog (issue #31) -- see `openerElRef` above. */
  const rfqOpenerElRef = useRef<HTMLElement | null>(null);

  /** See `beginLatestOnly` above for what these two guard against. */
  const deckAbortRef = useRef<AbortController | null>(null);
  const deckSeqRef = useRef(0);

  const loadDeck = useCallback(
    async (a: UnderlyingSymbol, d: Direction, h: number, { spinner = false } = {}): Promise<Deck | null> => {
      const started = beginLatestOnly(deckAbortRef, deckSeqRef, spinner);
      // A background poll tick, and a read is already in flight -- skip this tick
      // rather than starting a duplicate alongside it.
      if (!started) return null;
      const { signal, seq } = started;

      if (spinner) setLoading(true);
      try {
        const next = await getDeck({ asset: a, direction: d, horizonDays: h, sizeUsdc: STAKE_USDC, signal });
        // Superseded while in flight: a newer call already started, so this answer is
        // stale even though it arrived without error. Applying it would walk the Deck
        // backward to a price or a set of strikes the Trader already navigated past.
        if (!isLatest(deckSeqRef, seq)) return null;

        setDeck(next);
        setDeckError(null);

        /*
         * Land the Trader on an expiry that has something behind it.
         *
         * Two cases, one rule. Before they have chosen, open on the expiry with the MOST
         * Cards rather than the shortest -- one day is routinely the emptiest cell in the
         * whole book, and on a recent snapshot ETH puts at one day were a single Card
         * against nine at four days. A Trader's first impression should be the market as
         * it actually is.
         *
         * And after they have chosen, never leave them standing on a chip that answers
         * with nothing: changing direction re-evaluates which expiries are live, and no
         * Underlying quotes a put beyond three days at all.
         */
        const stillLive = next.expiries.find((e) => e.horizonDays === h)?.live ?? false;
        if (!expiryChosen.current || !stillLive) {
          const fullest = fullestExpiry(next.expiries);
          if (fullest !== null && fullest !== h) setHorizonState(fullest);
        }

        const { ref, perContract } = shownQuote.current;
        if (ref && perContract !== null) {
          const card = next.cards.find((c) => c.cardRef === ref);
          setQuoteMoved(!card || card.perContractUsd.display !== perContract);
        }
        return next;
      } catch (e) {
        // Cancelled by a newer call superseding this one -- not a real failure, and
        // not this call's place to say so; the newer call speaks for the Deck now.
        if (signal.aborted) return null;
        if (!isLatest(deckSeqRef, seq)) return null;
        setDeckError(e instanceof Error ? e.message : "The Deck could not be read.");
        return null;
      } finally {
        endLatestOnly(deckAbortRef, deckSeqRef, seq);
        if (isLatest(deckSeqRef, seq) && spinner) setLoading(false);
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
  // it would be six books re-read for a bar that would not visibly change. There is
  // still exactly one loading state to draw for it (issue #32): `marketsLoading` covers
  // this single request, start to finish, success or failure alike -- a rail that never
  // answers should not spin forever, only stop claiming to be loading.
  useEffect(() => {
    void getMarkets()
      .then((m) => setMarkets(m.markets))
      .catch(() => undefined)
      .finally(() => setMarketsLoading(false));
  }, []);

  /**
   * The tape is only honest if it keeps asking -- but only while somebody is looking.
   *
   * This comment used to read "Cheap: /deck is read-only and local", which was wrong in a
   * way that mattered. `/deck` costs a full book read, a market-data read and a
   * `getBookState` over every Position the indexer has ever recorded; the last of those
   * alone runs to about three seconds. Nothing about it is local.
   *
   * The server now shares those reads between viewers (`upstream.ts`), so the cost of one
   * more open tab is small -- but a backgrounded tab left open overnight was still firing
   * every six seconds forever, for a screen nobody was looking at. `pollWhileVisible`
   * stops that and catches up the moment the Trader comes back, so returning to the tab
   * never shows a stale tape while waiting for the next tick.
   */
  useEffect(
    () => pollWhileVisible(() => void loadDeck(asset, direction, horizonDays), DECK_POLL_MS),
    [asset, direction, horizonDays, loadDeck]
  );

  /**
   * The Maker Depth chart's data.
   *
   * Keyed on `asset` and `horizonDays` alone -- NOT `direction`. The chart shows every
   * expiry at once and is unfiltered by direction on purpose (issue #28): it orients a
   * Trader rather than duplicating the Deck, and a chart that emptied or re-fetched the
   * moment "Falls" became "Rises" would just be the Deck again, drawn as bars.
   *
   * `{ spinner }` mirrors `loadDeck` exactly, for the same reason (issue #32): the first
   * paint and an asset/horizon switch are requests a Trader is waiting on and get
   * `depthLoading`; the background poll below does not, or the chart would flash an
   * "Updating…" note every six seconds for a value that rarely moves. It ALSO doubles
   * as the "latest wins" signal `beginLatestOnly` reads -- see that function's comment.
   */
  const depthAbortRef = useRef<AbortController | null>(null);
  const depthSeqRef = useRef(0);

  const loadDepth = useCallback(async (a: UnderlyingSymbol, h: number, { spinner = false } = {}) => {
    const started = beginLatestOnly(depthAbortRef, depthSeqRef, spinner);
    if (!started) return;
    const { signal, seq } = started;

    if (spinner) setDepthLoading(true);
    try {
      const next = await getDepth({ asset: a, horizonDays: h, signal });
      if (!isLatest(depthSeqRef, seq)) return;
      setDepth(next);
      setDepthError(null);
    } catch (e) {
      if (signal.aborted) return;
      if (!isLatest(depthSeqRef, seq)) return;
      setDepthError(e instanceof Error ? e.message : "The Maker Depth chart could not be read.");
    } finally {
      endLatestOnly(depthAbortRef, depthSeqRef, seq);
      if (isLatest(depthSeqRef, seq) && spinner) setDepthLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDepth(asset, horizonDays, { spinner: true });
  }, [asset, horizonDays, loadDepth]);

  useEffect(
    () => pollWhileVisible(() => void loadDepth(asset, horizonDays), DECK_POLL_MS),
    [asset, horizonDays, loadDepth]
  );

  const clearSelection = useCallback(() => {
    setSelectedRef(null);
    setDealtRef(null);
    setResult(null);
    setQuoteMoved(false);
    setQuoteRefreshed(false);
    if (quoteRefreshedTimer.current) {
      clearTimeout(quoteRefreshedTimer.current);
      quoteRefreshedTimer.current = null;
    }
    setRefusal(null);
    setReceipt(null);
    setConfirmOpen(false);
    setSizeUsdcState(STAKE_USDC);
    setPracticeDone(false);
    shownQuote.current = { ref: null, perContract: null };
  }, []);

  /**
   * Escape, the backdrop, or the close button (issue #30). The same reset the picker
   * uses on every navigation -- closing mid-flow abandons it exactly the way changing
   * the asset or the direction already did, so there is one place that means "nothing
   * is being confirmed any more" rather than two that have to be kept in step.
   *
   * Focus returns to the Card that opened the confirmation -- see `openerElRef` above
   * for why that is captured here in `surface.ts` rather than read off
   * `document.activeElement` inside the modal itself.
   */
  const closeConfirm = useCallback(() => {
    const opener = openerElRef.current;
    clearSelection();
    opener?.focus?.();
  }, [clearSelection]);

  /**
   * Opens the RFQ door's dialog (issue #31), from either opener -- the door beside the
   * chips or the empty-Deck button.
   *
   * Reset to sensible defaults every time it opens, the same way `pick()` resets the
   * confirmation's size: a stale offset or tenor from a dialog closed minutes ago is
   * not a request the Trader is making now. The default offset leans the way the
   * current `direction` already points -- a Falls belief starts the slider below
   * spot, a Rises belief above it -- so the first thing the Trader sees is a strike
   * that agrees with what they already told the surface, not one they have to drag
   * past zero first.
   */
  const openRfq = useCallback(() => {
    rfqOpenerElRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRfqOffsetPctState(direction === "DOWN" ? -10 : 10);
    setRfqHorizonDaysState(14);
    setRfqSizeUsdcState(STAKE_USDC);
    setRfqRefusal(null);
    setRfqStatus(null);
    setRfqSettle(null);
    setRfqReceipt(null);
    rfqRequestIdRef.current = null;
    setRfqOpen(true);
  }, [direction]);

  /**
   * The strike slider's release (issue #31). Never called mid-drag -- the live value
   * while dragging stays local to `RfqModal`, so a pixel of pointer movement does not
   * re-render the whole surface. This is the one number an RFQ carries that the
   * browser originates itself, and it is never resolved to a dollar figure here: only
   * the server may do that, and only inside the 501's own echoed sentence.
   */
  const setRfqOffset = useCallback((pct: number) => {
    setRfqOffsetPctState(pct);
  }, []);

  const setRfqTenor = useCallback((days: RfqTenorDays) => {
    setRfqHorizonDaysState(days);
  }, []);

  /**
   * The RFQ's own size control. Unlike `setSize` above, this is not a server round
   * trip -- there is no Order to re-price, because nothing has been quoted yet. It
   * only clamps against `rfqSizeCapUsdc` (the Risk Budget remaining; there is no
   * Maker Depth to bind against for a contract that does not exist) and stores the
   * result, the same way `sizeUsdc` itself is a request parameter rather than a
   * figure a Trader reads.
   */
  const setRfqSize = useCallback(
    (usdc: number) => {
      const cap = rfqSizeCapUsdc(session?.remainingUsdc ?? 0);
      setRfqSizeUsdcState(clampSizeUsdc(usdc, SIZE_MIN_USDC, cap));
    },
    [session]
  );

  /**
   * The FIRST of two signatures: open a sealed-bid request on-chain (ADR-0017).
   *
   * Nothing is bought here and no premium is known -- an RFQ has no price until a maker
   * answers. What the Trader commits to is the Reserve Price, which the backend holds
   * against the Risk Budget from the moment this returns and which the OptionFactory
   * itself enforces once the transaction lands.
   *
   * Deliberately shaped like `confirm` rather than like a form submit: prepare, send,
   * then report the outcome so the chain -- not this browser -- decides whether it
   * worked. A prepared request whose transaction never went has to be reported too, or
   * its reservation sits on the Risk Budget until it times out.
   */
  const submitRfq = useCallback(async () => {
    if (!walletAddress || !walletVerified) {
      setRfqRefusal(
        "Connect and verify your wallet first \u2014 opening a request needs a signature from your own wallet."
      );
      return;
    }
    setRfqBusy(true);
    setRfqRefusal(null);
    let prepared: PreparedRfq | null = null;
    /**
     * Proof that a transaction reached the chain, and the pivot the whole error path
     * turns on. `sendTx` waits for its own receipt, so the moment this is set the
     * Reserve Price is a real commitment and the reservation behind it may NEVER be
     * released -- releasing deletes the record, and with it the only key that can
     * decrypt this request's sealed bids.
     */
    let broadcastTxHash: string | null = null;
    try {
      prepared = await requestRfq({
        underlying: asset,
        direction,
        strikeOffsetPct: rfqOffsetPct,
        horizonDays: rfqHorizonDays,
        sizeUsdc: rfqSizeUsdc,
        walletAddress,
      });
      broadcastTxHash = await sendTx(prepared.requestTx);

      // Retried rather than taken at face value: the backend answers 425 while its own
      // RPC catches up with the wallet's, and that "try again shortly" used to fall
      // through to the release path below and destroy a live request.
      const confirmed = await confirmWithRetry(confirmRfq, prepared.requestId, broadcastTxHash);
      if (!confirmed.opened || !confirmed.status) {
        // The chain itself says it did not open -- reverted, or no quotation id in the
        // receipt. The backend has already released the reservation, so there is nothing
        // stranded and nothing was charged.
        setRfqRefusal("The request did not open on-chain. No USDC moved. You can try again.");
        await refreshMoney();
        return;
      }
      rfqRequestIdRef.current = prepared.requestId;
      setRfqStatus(confirmed.status);
      say(`Requested: ${confirmed.status.ask.sentence}`);
      await refreshMoney();
    } catch (e) {
      // A reservation may only be given back when nothing was broadcast -- see
      // `shouldReleaseReservation`. `/rfq` reserves the Reserve Price synchronously the
      // moment it runs, so on that path the displayed budget has to catch up here too,
      // or the Trader reads a budget that looks untouched.
      if (shouldReleaseReservation({ prepared: prepared !== null, broadcastTxHash })) {
        await confirmRfq(prepared!.requestId).catch(() => {
          // The release itself failed. Say so rather than swallowing it: the Reserve
          // Price stays held until the one-hour TTL sweeps it, and a Trader looking at
          // budget they cannot spend deserves the reason (audit G6).
          setRfqRefusal(
            "That request was not opened, but the hold on your Risk Budget could not be released " +
              "just now. It clears automatically within the hour."
          );
        });
        await refreshMoney();
      }

      if (broadcastTxHash) {
        // Open on-chain, unconfirmed here. Keep the id so a reload can pick it back up,
        // and never call the no-hash confirm that would delete it.
        rfqRequestIdRef.current = prepared?.requestId ?? null;
        setRfqRefusal(RFQ_STRANDED_MESSAGE);
        await refreshMoney();
      } else if (e instanceof ApiRefusal) setRfqRefusal(e.message);
      else setRfqRefusal(e instanceof Error ? e.message : "The wallet could not open this request.");
    } finally {
      setRfqBusy(false);
    }
  }, [asset, direction, rfqOffsetPct, rfqHorizonDays, rfqSizeUsdc, walletAddress, walletVerified, say, refreshMoney]);

  /**
   * Poll the open request while it is still waiting.
   *
   * Stops the moment there is nothing left to learn -- settled, withdrawn, or nobody
   * answered -- rather than running forever behind a dialog nobody is watching. The
   * interval is generous because the offer window is measured in minutes and every tick
   * costs an on-chain read plus an indexer call.
   */
  useEffect(() => {
    const requestId = rfqRequestIdRef.current;
    if (!requestId || !rfqStatus) return;
    if (rfqStatus.phase === "SETTLED" || rfqStatus.phase === "CANCELLED" || rfqStatus.phase === "NO_OFFERS") return;

    const controller = new AbortController();
    const timer = setInterval(() => {
      void getRfqStatus(requestId, controller.signal)
        .then(setRfqStatus)
        // A poll that fails is just a poll: the next one tries again, and turning a blip
        // into a refusal on screen would tell the Trader something is wrong while the
        // request sits on-chain doing exactly what it should.
        .catch(() => {});
    }, RFQ_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [rfqStatus]);

  /**
   * The SECOND signature: accept a maker's own price and pay it.
   *
   * The premium the dialog shows comes from `prepareRfqSettle` and is the exact amount
   * encoded into the transaction being signed, so the number confirmed and the number
   * charged cannot differ -- and if the chain disagrees, it reverts rather than
   * overcharging. ADR-0008 says no signature without a human confirmation, and a
   * confirmation of a blank is not a confirmation.
   */
  const acceptRfq = useCallback(async () => {
    const requestId = rfqRequestIdRef.current;
    if (!requestId) return;
    setRfqBusy(true);
    setRfqRefusal(null);
    let prepared: PreparedRfqSettle | null = null;
    try {
      prepared = await prepareRfqSettle(requestId);
      setRfqSettle(prepared);
      if (prepared.approveTx) await sendTx(prepared.approveTx);
      const txHash = await sendTx(prepared.settleTx);

      // The wallet has broadcast and mined this -- the money has moved. Everything from
      // here is bookkeeping, so a failure to reach /rfq/settle must never be caught below
      // and reported as a failed purchase.
      const done = await settleRfq(requestId, txHash).catch(() => null);
      if (done) setRfqStatus(done.status);

      setRfqReceipt({
        txHash,
        optionAddress: done?.status.optionAddress ?? "",
        explorerUrl: `${prepared.explorerTxUrlBase}${txHash}`,
      });
      say(
        `Bought. ${prepared.ask.contracts.display} ${asset} contracts at ${prepared.ask.strike.display}, paid ${prepared.premiumUsdc.display}.`
      );
      await refreshMoney();
    } catch (e) {
      if (prepared) {
        await settleRfq(requestId, undefined).catch(() => {});
        await refreshMoney();
      }
      if (e instanceof ApiRefusal) setRfqRefusal(e.message);
      else setRfqRefusal(e instanceof Error ? e.message : "The wallet could not complete this purchase.");
    } finally {
      setRfqBusy(false);
    }
  }, [asset, say, refreshMoney]);

  /** Withdraw a request nobody answered, taking the commitment to pay back off the chain. */
  const withdrawRfq = useCallback(async () => {
    const requestId = rfqRequestIdRef.current;
    if (!requestId) return;
    setRfqBusy(true);
    setRfqRefusal(null);
    try {
      const prepared = await prepareRfqCancel(requestId);
      const txHash = await sendTx(prepared.cancelTx);
      await cancelRfq(requestId, txHash).catch(() => {});
      const status = await getRfqStatus(requestId).catch(() => null);
      if (status) setRfqStatus(status);
      await refreshMoney();
    } catch (e) {
      if (e instanceof ApiRefusal) setRfqRefusal(e.message);
      else setRfqRefusal(e instanceof Error ? e.message : "The wallet could not withdraw this request.");
    } finally {
      setRfqBusy(false);
    }
  }, [refreshMoney]);

  /** Escape, the backdrop, or the close button. Focus returns to whichever door opened it. */
  const closeRfq = useCallback(() => {
    const opener = rfqOpenerElRef.current;
    setRfqOpen(false);
    setRfqRefusal(null);
    // Dismissing the dialog forgets the request on THIS screen; it does not withdraw it.
    // The request stays live on-chain until it settles, is withdrawn, or expires, and the
    // Risk Budget goes on holding its Reserve Price -- which is the truth, and the
    // opposite of what quietly releasing it here would imply.
    setRfqStatus(null);
    setRfqSettle(null);
    setRfqReceipt(null);
    rfqRequestIdRef.current = null;
    opener?.focus?.();
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
      // A horizon chosen for one Underlying says nothing about the next -- the four
      // cash-settled ones quote a much shorter grid than ETH and BTC.
      expiryChosen.current = false;
      setAssetState(a);
    },
    [asset, clearSelection]
  );

  const setDirection = useCallback(
    (d: Direction) => {
      if (d === direction) return;
      clearSelection();
      // Which expiries are live is a property of the DIRECTION as well as the
      // Underlying: no Underlying quotes a put beyond three days, while ETH and BTC
      // quote calls out to about sixty.
      expiryChosen.current = false;
      setDirectionState(d);
    },
    [direction, clearSelection]
  );

  const setHorizon = useCallback(
    (h: number) => {
      if (h === horizonDays) return;
      clearSelection();
      expiryChosen.current = true;
      setHorizonState(h);
    },
    [horizonDays, clearSelection]
  );

  /**
   * Ask the server for a trade and hang the surface off its answer.
   *
   * `cardRef` present means the Trader overruled the agent. The distinction is not made
   * here -- the server answers with `chosenBy`, and the surface marks what it is told.
   *
   * `size` is always passed explicitly rather than read off `sizeUsdc` state -- a
   * caller that just called `setSizeUsdcState` cannot rely on this callback's own
   * closure having seen that update yet, and a stale size sent to the one call that
   * prices the Order is exactly the bug ADR-0006 exists to prevent. `on` says the same
   * for the Underlying and the horizon, which `deal` now also moves in the same tick.
   */
  const ask = useCallback(
    async (
      cardRef: string | undefined,
      asking: Direction,
      size: number,
      on: { underlying?: UnderlyingSymbol; horizonDays?: number; contracts?: number } = {}
    ) => {
      setBusy(true);
      setRefusal(null);
      setReceipt(null);
      setPracticeDone(false);
      // Read once: the answer is compared against the horizon this call actually asked
      // for, not against state the caller may have set in this same tick.
      const askedHorizon = on.horizonDays ?? horizonDays;
      try {
        const answer = await propose({
          underlying: on.underlying ?? asset,
          direction: asking,
          horizonDays: askedHorizon,
          sizeUsdc: size,
          cardRef,
          // Present only when the Trader typed a contract count. The server converts it
          // against this Order and answers in both units; nothing here does that sum.
          ...(on.contracts !== undefined ? { contracts: on.contracts } : {}),
        });
        setResult(answer);
        setQuoteMoved(false);

        if (answer.kind === "PROPOSAL") {
          setSelectedRef(answer.cardRef);
          if (answer.proposal.chosenBy === "AGENT") setDealtRef(answer.cardRef);
          shownQuote.current = { ref: answer.cardRef, perContract: answer.proposal.figures.perContractUsd.display };
          // The server takes the nearest live expiry, so the Order dealt can sit in a
          // bucket we are not showing -- and its Card would be in a Deck the Trader
          // cannot see, so nothing highlights. Follow the answer to its own expiry.
          if (answer.horizonDays !== askedHorizon) {
            expiryChosen.current = true;
            setHorizonState(answer.horizonDays);
          }
        } else {
          shownQuote.current = { ref: null, perContract: null };
        }
        return answer;
      } catch (e) {
        if (e instanceof ApiRefusal) {
          setRefusal(e.message);
          setResult(null);
          shownQuote.current = { ref: null, perContract: null };
          return null;
        }
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [asset, horizonDays]
  );

  /**
   * Deal, optionally against a full Trade Intent rather than just today's state.
   *
   * A Suggestion carries `{ underlying, direction, sizeUsdc, horizonDays }` together and
   * all four have to land together or not at all -- a direction taken with the size
   * silently left behind, or an ETH Suggestion dealt against whichever Underlying the
   * rail happens to have selected, is the exact bug this exists to prevent. Whatever the
   * intent omits holds at its current value.
   *
   * This is NOT the chat driving the picker: `setAsset`'s comment rules out reading an
   * asset name out of a sentence, which would be a model originating a selection. An
   * intent's `underlying` is a structured field the Strategy Agent chose deterministically,
   * and honouring it is the only way the trade dealt is the trade suggested.
   *
   * A horizon that is not a whole number of days is refused loudly rather than clamped or
   * dropped -- silently coercing one would deal an expiry nobody asked for. A horizon that
   * is well-formed but has nothing behind it needs no guard here: `loadDeck` already moves
   * a Trader off a chip that answers with nothing.
   */
  const deal = useCallback(
    async (line?: string, intent?: Partial<TradeIntent>, opts?: { confirm?: boolean }) => {
      if (line) heard(line);

      if (intent?.horizonDays !== undefined && !Number.isInteger(intent.horizonDays)) {
        throw new Error(
          `deal: horizonDays must be a whole number of days -- got ${intent.horizonDays}. Refusing to guess.`
        );
      }

      const askingAsset = intent?.underlying ?? asset;
      const asking = intent?.direction ?? direction;
      const askingHorizon = intent?.horizonDays ?? horizonDays;
      const askingSize = intent?.sizeUsdc ?? STAKE_USDC;

      if (askingAsset !== asset || asking !== direction || askingHorizon !== horizonDays) {
        clearSelection();
        // An intent that names a horizon chose it; anything else leaves `loadDeck` free
        // to open on the fullest expiry, exactly as a direction switch does today.
        expiryChosen.current = intent?.horizonDays !== undefined;
        setAssetState(askingAsset);
        setDirectionState(asking);
        setHorizonState(askingHorizon);
        // Awaited for its side effect only -- the Deck it returns was read solely by the
        // narration this path no longer writes, and the Deck it sets is what the Cards
        // on the right render from.
        await loadDeck(askingAsset, asking, askingHorizon, { spinner: true });
      }

      setSizeUsdcState(askingSize);
      const answer = await ask(undefined, asking, askingSize, {
        underlying: askingAsset,
        horizonDays: askingHorizon,
      });
      if (answer?.kind === "PROPOSAL") {
        // Deliberately silent. This path deals a Deck -- from a seed prompt or an
        // accepted Suggestion -- and the Deck itself is the answer: the dealt Card is
        // already lit on the right by `dealtRef`. Narrating it here restated, in prose,
        // figures the Trader can already read on the Card, and put a premium (which is
        // the Max Loss, ADR-0002) into the transcript for no gain.
        //
        // opt-in only -- the seed prompts call deal() without opts and just deal, same as
        // always. Reuses this already-priced proposal instead of asking again, since a
        // second ask() would relabel it as a Trader override rather than an agent Suggestion.
        if (opts?.confirm) {
          openerElRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setConfirmOpen(true);
        }
      } else if (answer?.kind === "NO_ORDER") {
        say(answer.message);
      }
      // Handed back so a caller can tell a dealt proposal from a VETO, a NO_ORDER or a
      // refusal `ask` already swallowed. Callers that only wanted the side effects --
      // the seed prompts -- can keep ignoring it.
      return answer;
    },
    [ask, asset, clearSelection, direction, heard, horizonDays, loadDeck, say]
  );

  /**
   * Clicking a Card (issue #30), or accepting an AI-matched order. Prices it at the
   * default stake and opens the confirmation -- the only Confirm in the product now
   * lives there, so this is the one deliberate act that puts a Trader in front of it.
   *
   * `on`, when given and different from what's currently selected, switches the
   * coin/direction/expiry chips first -- the same raw setters `deal()` already uses
   * directly, which arm the existing Deck-reload effect (lines 793-796) in the
   * background. Not awaited: `ask()` below prices directly against `on`'s own fields,
   * never against `deck` state, so the confirmation is correct immediately regardless
   * of how long the background Deck refetch takes to catch up.
   */
  const pick = useCallback(
    async (cardRef: string, on?: { underlying: UnderlyingSymbol; direction: Direction; horizonDays: number }) => {
      if (busy) return;
      // Before anything else: `busy` is about to go true, which disables this same
      // Card's button in the same render that opens the confirmation. Capture it now,
      // while it is still the enabled, focused element -- an effect inside the modal
      // would run one render too late to see it.
      openerElRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

      const askingAsset = on?.underlying ?? asset;
      const askingDirection = on?.direction ?? direction;
      const askingHorizon = on?.horizonDays ?? horizonDays;
      if (askingAsset !== asset || askingDirection !== direction || askingHorizon !== horizonDays) {
        expiryChosen.current = true;
        setAssetState(askingAsset);
        setDirectionState(askingDirection);
        setHorizonState(askingHorizon);
        // A Card the agent dealt on the OLD selection is not the agent's pick on this
        // new one -- `deal()` clears the same flag on a switch, for the same reason.
        // Harmless either way (cardRefs are per-session HMACs, so a stale ref cannot
        // collide with anything in the new Deck), but leaving it set would still be an
        // unexplained divergence from that sibling path.
        setDealtRef(null);
      }

      setSizeUsdcState(STAKE_USDC);
      setConfirmOpen(true);
      // Deliberately silent on success. The Trader clicked a Card and a confirmation
      // opened on top of it carrying every one of these figures -- saying them again in
      // the transcript, in prose, answered a question nobody asked. A refusal still
      // speaks: `ask` itself logs those.
      await ask(cardRef, askingDirection, STAKE_USDC, { underlying: askingAsset, horizonDays: askingHorizon });
    },
    [ask, busy, direction, asset, horizonDays]
  );

  /**
   * Natural language trade entry point: sends user's free text to /propose/chat,
   * updates active Deck/asset/direction/horizon/size, highlights the proposed Card,
   * explains the trade in chat, and opens the confirmation modal for human review.
   */
  const submitTradeMessage = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt) return;
      heard(prompt);
      setBusy(true);
      setRefusal(null);
      setReceipt(null);
      setPracticeDone(false);
      try {
        const answer = await proposeChat({ prompt });
        setQuoteMoved(false);

        if (answer.kind === "PROPOSAL") {
          // NOTHING on the right moves.
          //
          // This used to read the answer's Trade Intent and drag the whole surface after
          // it -- asset, direction, expiry, stake, and a Deck reload -- so a sentence
          // typed on the left silently replaced the Cards the Trader was reading on the
          // right. The Deck is the Trader's own browsing context; a question about a
          // 2-day ETH put is not an instruction to stop looking at whatever they had
          // open.
          //
          // Nothing is lost by staying put, because the answer is self-contained: the
          // Card below carries its own underlying, direction and expiry, and "Place
          // order" hands all three to `pick`, which switches the Deck at that point --
          // when the Trader has actually chosen to go there. `selectedRef`/`dealtRef`
          // are deliberately not set either: they ring a Card in the Deck on screen, and
          // this Order is not in it.
          //
          // The confirmation deliberately does NOT open here either. It used to, which
          // made a typed sentence the one path in the product that put a spend a single
          // click away without the Trader having chosen to look at it -- the shape
          // ADR-0009 removed the commit bar to avoid.
          //
          // `result` stays untouched for the same reason: it drives the payoff strip and
          // the "the agent picked $X" tag above the Deck, and naming a strike that is not
          // in the row underneath it is worse than saying nothing.
          const expl = answer.explanation || `I found the ${answer.proposal.figures.strike.display} option for you.`;
          say(expl);

          const f = answer.proposal.figures;
          showProposal({
            who: "copilot",
            kind: "proposal",
            cardRef: answer.cardRef,
            // Off the proposal's own intent, never off local state: `pick` re-selects
            // asset/direction/expiry from these, so a Card dealt on one selection still
            // opens correctly after the Trader has moved the Deck somewhere else.
            underlying: answer.proposal.intent.underlying,
            direction: answer.proposal.intent.direction,
            horizonDays: answer.horizonDays,
            strike: f.strike,
            premiumUsdc: f.premiumUsdc,
            expiry: f.expiry,
          });
        } else if (answer.kind === "NO_ORDER") {
          // Said in the chat and nowhere else. "Nothing matched" is an answer to what was
          // typed, not a condition of the book the Trader is browsing -- the Deck on the
          // right is still full of perfectly good Cards, and replacing it with an
          // empty-Deck halt would be this panel lying about the market.
          shownQuote.current = { ref: null, perContract: null };
          say(answer.message || "No suitable order found for that horizon and direction.");
        } else if (answer.kind === "VETO") {
          // The one thing a typed sentence still puts on the right, deliberately. ADR-0006
          // makes the Review Agent's veto the only word that can stop a trade, and
          // ADR-0009 says it has to read across a room -- a refusal that appears only as
          // another grey line in a transcript is a refusal that can be scrolled past.
          // Nothing is priced or opened either way; this is louder, not further along.
          setResult(answer);
          shownQuote.current = { ref: null, perContract: null };
          say(answer.explanation || "Review agent vetoed this trade intent.");
        }
        return answer;
      } catch (e) {
        const message =
          e instanceof ApiRefusal
            ? e.message
            : e instanceof Error && (e.message.includes("Failed to fetch") || e.message.includes("fetch"))
            ? "Could not reach the backend API server. Make sure `npm run dev` is running on port 3001."
            : e instanceof Error
            ? e.message
            : "Could not process that trade.";
        setRefusal(message);
        setResult(null);
        shownQuote.current = { ref: null, perContract: null };
        say(message);
        return null;
      } finally {

        setBusy(false);
      }
    },
    // `asset`, `direction`, `horizonDays`, `clearSelection` and `loadDeck` are all gone
    // from here: this path no longer reads or moves the Deck's selection at all.
    [heard, say, showProposal]
  );

  /**
   * The confirmation's stepper and presets (issue #30): the SAME Order, a different
   * stake. A server round trip against the unchanged `cardRef`, so a Trader dragging
   * the size up or down is never reading a figure this file adjusted itself.
   */
  const setSize = useCallback(
    async (usdc: number) => {
      if (!selectedRef || busy) return;
      setSizeUsdcState(usdc);
      await ask(selectedRef, direction, usdc);
    },
    [ask, selectedRef, direction, busy]
  );

  /**
   * The same control asked in the other unit: the SAME Order, a stake expressed as a
   * number of contracts.
   *
   * The two fields in the confirmation are one quantity, and this is why they can stay
   * in step without either of them doing the conversion. The count goes to the server,
   * the server prices the Order at that many contracts, and the dollar field is set from
   * `intent.sizeUsdc` on the answer -- the stake the server actually used, not one this
   * file worked out. So "type 1.2 contracts" and "type $5" are the same round trip in
   * opposite directions, and neither number on screen was derived in the browser.
   *
   * `sizeUsdc` is still passed along because `/propose` requires a stake to parse; the
   * server ignores it whenever `contracts` is present.
   */
  const setContracts = useCallback(
    async (count: number) => {
      if (!selectedRef || busy) return;
      const answer = await ask(selectedRef, direction, sizeUsdc, { contracts: count });
      if (answer?.kind === "PROPOSAL") setSizeUsdcState(answer.proposal.intent.sizeUsdc);
    },
    [ask, selectedRef, direction, busy, sizeUsdc]
  );

  /**
   * `ask` sets `busy` true as the very first thing it does, synchronously, before its
   * own first `await` -- so an effect that both reads `busy` as a dependency AND calls
   * `ask` cancels itself the instant it starts: the `busy` flip reruns the effect,
   * which runs the previous invocation's cleanup, which marks the very call it just
   * made as stale before that call's own response ever arrives. This ref is how the
   * refresh effect below reads the CURRENT `busy` value without depending on it.
   */
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  /**
   * The moment the background poll notices the confirmed Order's price moved
   * (`quoteMoved`), re-price that SAME Order automatically -- the same round trip
   * `setSize` above already makes for a different reason -- instead of leaving the
   * Trader behind a dead end that says to close the confirmation and start over. `ask`
   * itself clears `quoteMoved` the instant its answer lands (its normal behaviour, not
   * anything special added here); this effect only exists to actually make that call
   * and to say out loud that a refresh just happened, so glancing away for a moment
   * never means confirming a number that was never actually shown.
   *
   * Safe to call unconditionally on any `quoteMoved`, including the rare case the
   * Order vanished entirely rather than merely repriced: `ask` still resolves then,
   * just to a non-PROPOSAL answer, and the confirmation's own existing "That Card
   * could not be priced" branch already covers exactly that outcome -- nothing new to
   * handle here for it.
   *
   * `busyRef`, not `busy`, per the comment above it: this only needs to check whether
   * something else (a resize, a real Confirm/Practice Run) is already in flight at the
   * moment the poll notices a move -- it must never treat its own resulting `ask` call
   * as a reason to abandon that same call.
   */
  useEffect(() => {
    if (!quoteMoved || !selectedRef || busyRef.current) return;
    let cancelled = false;
    void ask(selectedRef, direction, sizeUsdc).then((answer) => {
      if (cancelled || answer?.kind !== "PROPOSAL") return;
      setQuoteRefreshed(true);
      if (quoteRefreshedTimer.current) clearTimeout(quoteRefreshedTimer.current);
      quoteRefreshedTimer.current = setTimeout(() => setQuoteRefreshed(false), 4000);
    });
    return () => {
      cancelled = true;
    };
  }, [quoteMoved, selectedRef, direction, sizeUsdc, ask]);

  /**
   * Spends real USDC, signed by the Trader's own connected AND verified wallet
   * (ADR-0011, ADR-0012). Reached only from the Trader's own press, inside the
   * confirmation. The proposal stays on screen after this succeeds -- issue #30 wants
   * the receipt shown alongside the trade it belongs to, not a Trader who has just
   * spent money looking at a form that has already reset itself. `closeConfirm` is
   * what clears it, on the Trader's own dismissal.
   */
  const confirm = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    if (!walletAddress || !walletVerified) {
      setRefusal("Connect and verify your wallet first — Confirm needs a signature from your own wallet.");
      return;
    }
    setBusy(true);
    setRefusal(null);
    let prepared: PreparedFill | null = null;
    try {
      prepared = await prepareFill(p.proposalId, walletAddress);
      if (prepared.approveTx) await sendTx(prepared.approveTx);
      const txHash = await sendTx(prepared.fillTx);

      // The wallet has already broadcast and mined this -- the Trader's money has
      // moved. Everything from here is bookkeeping, so a failure to reach
      // /fill/settle must never be caught below and reported as a failed fill.
      await settleWithRetry(p.proposalId, txHash).catch(() => {});

      say(`Bought. ${p.proposal.figures.contracts.display} contracts at ${p.proposal.figures.strike.display}, paid ${p.proposal.figures.premiumUsdc.display}.`);
      // The proposal and Card stay on screen -- issue #30's ConfirmModal shows the
      // receipt alongside the trade it belongs to, and `closeConfirm` is what clears
      // the selection, on the Trader's own dismissal, not this success path.
      setReceipt({ txHash, optionAddress: prepared.optionAddress, explorerUrl: `${prepared.explorerTxUrlBase}${txHash}` });
      await refreshMoney();
    } catch (e) {
      // Only settle(false) if prepare actually succeeded -- there is nothing to release
      // if the reservation was never made. /fill/prepare reserves the Risk Budget
      // synchronously on the server the moment it runs, so the display has to catch up
      // here too -- not just on the success path -- or a Trader sees a budget that
      // still looks untouched while a reservation sits released behind it.
      if (prepared) {
        await settleWithRetry(p.proposalId, undefined).catch(() => {});
        await refreshMoney();
      }
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else setRefusal(e instanceof Error ? e.message : "The wallet could not complete this fill.");
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, walletAddress, walletVerified, say, refreshMoney]);

  /** Opens a simulated Position. A different function, on a different route. */
  const runPractice = useCallback(async () => {
    const p = proposalOf(result);
    if (!p || quoteMoved) return;
    setBusy(true);
    setRefusal(null);
    try {
      await practice(p.proposalId);
      // Silent here too: `practiceDone` renders the receipt inside the confirmation the
      // Trader is still looking at (ConfirmModal.tsx), which is both nearer and more
      // legible than the same sentence in a transcript behind it.
      setPracticeDone(true);
      await refreshMoney();
    } catch (e) {
      if (e instanceof ApiRefusal) setRefusal(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }, [result, quoteMoved, say, refreshMoney]);

  const reset = useCallback(() => {
    clearSelection();
    void loadDeck(asset, direction, horizonDays, { spinner: true });
  }, [asset, clearSelection, loadDeck, direction, horizonDays]);

  const selectedCard = deck?.cards.find((c) => c.cardRef === selectedRef) ?? null;

  return {
    asset,
    markets,
    marketsLoading,
    direction,
    horizonDays,
    deck,
    deckError,
    loading,
    depth,
    depthError,
    depthLoading,
    selectedRef,
    dealtRef,
    selectedCard,
    result,
    quoteMoved,
    quoteRefreshed,
    refusal,
    confirmOpen,
    sizeUsdc,
    practiceDone,
    rfqOpen,
    rfqOffsetPct,
    rfqHorizonDays,
    rfqSizeUsdc,
    rfqBusy,
    rfqRefusal,
    rfqStatus,
    rfqSettle,
    rfqReceipt,
    session,
    board,
    boardLoading,
    receipt,
    busy,
    log,
    account,
    signOut,
    walletAddress,
    walletConnecting,
    walletVerified,
    walletVerifying,
    walletError,
    walletPickerOpen,
    availableWallets,
    recentWallet,
    onOpenWalletPicker: openWalletPicker,
    onCloseWalletPicker: closeWalletPicker,
    onPickWallet: pickWallet,
    verifyWallet: () => (walletAddress ? verifyWalletFor(walletAddress) : Promise.resolve()),
    onDisconnectWallet: () => void disconnectWallet(),
    setAsset,
    setDirection,
    setHorizon,
    deal,
    submitTradeMessage,
    pick,
    setSize,
    setContracts,
    confirm,
    runPractice,
    closeConfirm,
    openRfq,
    setRfqOffset,
    setRfqTenor,
    setRfqSize,
    submitRfq,
    acceptRfq,
    withdrawRfq,
    closeRfq,
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
