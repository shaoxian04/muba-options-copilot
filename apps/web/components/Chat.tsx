"use client";

/**
 * The left column: language.
 *
 * One panel, two engines, switched by a local tab -- never a navigation, so the same
 * chatbox stays mounted and only which backend a submitted message reaches changes.
 *
 * "Trade" is the Copilot that proposes and explains -- it cannot spend, nothing in this
 * mode can reach `/fill` or `/practice`, and the only thing a seed does is ask the
 * server for a proposal, which signs nothing. "Insights" is the Forecast subsystem
 * (ADR-0005): real market data, news, price predictions, risk/benefit views, and
 * comparisons across coins, answered from a free-text question.
 *
 * The Insights conversation (and the question a "please specify..." reply is still
 * completing) lives here in `Chat`, not inside the Insights view itself -- that view
 * unmounts every time the tab switches to Trade, and a local `useState` would reset
 * with it. Persisted to `sessionStorage` too, so it also survives an accidental
 * refresh -- same pattern `sessionId()` in `lib/api.ts` already uses for the Trade
 * session id, under its own key so the two never collide.
 *
 * ADR-0005's actual requirement -- a Forecast must never render beside a Max Loss or
 * inside a confirmation -- still holds structurally here: this panel never renders
 * Deck/CommitBar content in either mode, and nothing an Insights answer produces ever
 * reaches the Confirm side of the app.
 *
 * Every figure the Trade engine narrates is a `display` string lifted out of a server
 * response -- the Copilot may say a number aloud; it may never be the reason a number
 * exists (ADR-0006). The Insights engine's numbers follow the same spirit without the
 * strict Figure-string pairing that convention uses elsewhere: Forecast data was never
 * part of a money decision, so a plain server-fetched number is enough.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { usePathname } from "next/navigation";
import type { ChatLine, TradeIntent } from "../lib/surface";
import type { ProposeResult } from "../lib/api";
import { askForecast } from "../lib/api";
import { deriveHistory, type InsightsLine } from "../lib/insightsHistory";
import { SuggestionCard } from "./SuggestionCard";

export interface Seed {
  said: string;
  run: () => void;
}

type Engine = "trade" | "insights";

const INSIGHTS_LOG_KEY = "copilot-insights-log";
const INSIGHTS_PENDING_KEY = "copilot-insights-pending";

function loadInsightsLog(): InsightsLine[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(INSIGHTS_LOG_KEY);
    return raw ? (JSON.parse(raw) as InsightsLine[]) : [];
  } catch {
    return [];
  }
}

function loadInsightsPending(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(INSIGHTS_PENDING_KEY);
  } catch {
    return null;
  }
}

export function Chat({
  log,
  seeds,
  busy,
  deal,
  walletVerified,
}: {
  log: ChatLine[];
  seeds: Seed[];
  busy: boolean;
  /** Same signature as `Surface.deal` -- threaded down to Suggestion for Accept (task 5). */
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  /** Whether the session has proven wallet ownership (ADR-0012) -- gates the Risk Profile. */
  walletVerified: boolean;
}) {
  // The route this page happened to load from decides the starting tab (so a direct
  // hit or refresh on /insights opens there) -- but switching tabs afterward never
  // navigates through Next's router, only updates the address bar directly (below).
  // That keeps this component, and everything above it, mounted exactly once.
  const pathname = usePathname();
  const [engine, setEngine] = useState<Engine>(pathname === "/insights" ? "insights" : "trade");

  // Starts empty on every render, server and client alike -- sessionStorage does not
  // exist on the server at all, so seeding this from it in a useState initializer
  // (the original version of this code did) makes the client's first render disagree
  // with what the server sent down, which React treats as a hydration error and
  // discards the whole tree to recover. Loading the real, saved conversation happens
  // below, in an effect that only ever runs after hydration has already succeeded.
  const [insightsLog, setInsightsLog] = useState<InsightsLine[]>([]);
  const [insightsPending, setInsightsPending] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  function selectEngine(next: Engine) {
    setEngine(next);
    window.history.pushState(null, "", next === "insights" ? "/insights" : "/");
  }

  // The browser's own back/forward buttons move the address bar without React ever
  // hearing about it -- this is what makes the tab follow along when they're used.
  useEffect(() => {
    function onPopState() {
      setEngine(window.location.pathname === "/insights" ? "insights" : "trade");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setInsightsLog(loadInsightsLog());
    setInsightsPending(loadInsightsPending());
    setHydrated(true);
  }, []);

  useEffect(() => {
    // Skip the write on the same pass that just loaded from storage -- otherwise this
    // fires with the still-empty initial value before that load's setState has taken
    // effect, and overwrites the real saved conversation with "[]" moments after
    // reading it.
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(INSIGHTS_LOG_KEY, JSON.stringify(insightsLog));
    } catch {
      // A private window with site data blocked can throw here -- losing persistence
      // is fine, the conversation still works for the rest of this page load.
    }
  }, [insightsLog, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (insightsPending) window.sessionStorage.setItem(INSIGHTS_PENDING_KEY, insightsPending);
      else window.sessionStorage.removeItem(INSIGHTS_PENDING_KEY);
    } catch {
      // see above
    }
  }, [insightsPending, hydrated]);

  return (
    <div className="chat">
      <div className="hd">
        <span className="who">Copilot</span>
        <span className="lbl">{engine === "trade" ? "proposes · never spends" : "answers · never trades"}</span>
      </div>

      <div className="engine-tabs" role="tablist" aria-label="What Copilot is doing">
        <button type="button" role="tab" aria-selected={engine === "trade"} onClick={() => selectEngine("trade")}>
          Trade
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={engine === "insights"}
          onClick={() => selectEngine("insights")}
        >
          Insights
        </button>
      </div>

      {engine === "trade" ? (
        <TradeEngine log={log} seeds={seeds} busy={busy} />
      ) : (
        <InsightsEngine
          log={insightsLog}
          setLog={setInsightsLog}
          pending={insightsPending}
          setPending={setInsightsPending}
          deal={deal}
          walletVerified={walletVerified}
          onAccepted={() => selectEngine("trade")}
        />
      )}
    </div>
  );
}

function TradeEngine({ log, seeds, busy }: { log: ChatLine[]; seeds: Seed[]; busy: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <>
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {log.length === 0 ? (
          <p className="from-copilot">
            The Deck is on the right — every option you could buy right now, cheapest long shots first. Have a
            poke. Nothing is bought until you press a button.
          </p>
        ) : (
          log.map((line, i) => (
            <p key={i} className={`from-${line.who}`}>
              {line.text}
            </p>
          ))
        )}
      </div>

      <div className="seeds">
        {seeds.map((seed) => (
          <button key={seed.said} type="button" onClick={seed.run} disabled={busy}>
            {seed.said}
          </button>
        ))}
      </div>

      {/*
        A text box would imply the language layer exists for trading. It does not yet --
        the Trade, Review and Strategy Agents are a separate Python service that has not
        been started (ADR-0007) -- and a dead input is a worse lie than an honest note.
      */}
      <p className="box">Typing arrives with the agents service. Until then the prompts above stand in for it.</p>
    </>
  );
}

function InsightsEngine({
  log,
  setLog,
  pending,
  setPending,
  deal,
  walletVerified,
  onAccepted,
}: {
  log: InsightsLine[];
  setLog: Dispatch<SetStateAction<InsightsLine[]>>;
  pending: string | null;
  setPending: Dispatch<SetStateAction<string | null>>;
  deal: (line?: string, intent?: Partial<TradeIntent>) => Promise<ProposeResult | null>;
  walletVerified: boolean;
  onAccepted: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy]);

  async function ask() {
    const fragment = question.trim();
    if (!fragment || busy) return;
    setQuestion("");
    setLog((prev) => [...prev, { who: "trader", text: fragment }]);
    setBusy(true);

    // `pending` handles only one thing -- completing a "please specify..."
    // clarification, unchanged from before. `history` is separate: the last few
    // successful exchanges, sent as lightweight memory so a genuine follow-up
    // ("what about SOL too?") can be resolved without dragging the whole
    // conversation along.
    const combined = pending ? `${pending} ${fragment}` : fragment;
    const history = deriveHistory(log);

    try {
      const results = await askForecast(combined, history);
      setLog((prev) => [...prev, { who: "copilot", results }]);
      setPending(null);
    } catch (e: any) {
      const message = e?.message ?? "Something went wrong.";
      setLog((prev) => [...prev, { who: "copilot", text: message }]);
      // Only a "please specify" clarification keeps the conversation open -- any other
      // failure (an unrecognized symbol, a server error) is terminal for this question,
      // so the next message starts fresh instead of dragging it along.
      setPending(/^please specify/i.test(message) ? combined : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="log" ref={logRef} role="log" aria-live="polite" aria-label="Insights conversation">
        {log.length === 0 ? (
          <p className="from-copilot">
            Ask about any coin. Real data only; nothing here can reach a trade.
          </p>
        ) : (
          log.map((line, i) =>
            line.who === "trader" ? (
              <p key={i} className="from-trader">
                {line.text}
              </p>
            ) : line.results ? (
              <div key={i} className="from-copilot">
                {Object.entries(line.results).map(([symbol, r]) => (
                  <div key={symbol} className="coin-answer">
                    <strong>{symbol}: </strong>
                    {r.error ? <span className="err">{r.error}</span> : <span>{r.answer}</span>}
                    {r.disclaimer ? <div className="disclaimer">{r.disclaimer}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p key={i} className="from-copilot">
                {line.text}
              </p>
            )
          )
        )}
        {busy ? <p className="from-copilot">Asking…</p> : null}
      </div>

      <SuggestionCard deal={deal} walletVerified={walletVerified} onAccepted={onAccepted} />

      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about any coin…"
          disabled={busy}
          aria-label="Ask a question"
        />
        <button type="submit" className="ask-submit" disabled={busy || !question.trim()}>
          <span aria-hidden="true">→</span> Ask
        </button>
      </form>
    </>
  );
}
