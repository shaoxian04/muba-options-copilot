"use client";

/**
 * "Yours": an Open | History toggle wrapped around the existing Board.
 *
 * Open renders exactly what rendered before this component existed -- `<Board>`, same
 * props, unchanged -- so den51's VETO handling and Board.tsx itself stay untouched.
 * History is new: `GET /history` (ADR-0018, apps/api/src/history.ts), fetched only once
 * the tab is actually selected, never on mount, since most sessions never open it.
 *
 * Tab semantics copied from Chat.tsx's `engine-tabs` block. The sign-in gate copied
 * from SuggestionCard.tsx: `GET /history` 401s with no account signed in (`requireAccount`),
 * and that is not an error to show -- it is the same "sign in first" note Insights uses.
 */
import { useEffect, useState } from "react";
import type { Holding } from "@copilot/shared";
import { ApiRefusal, getHistory, type HistoryItem } from "../lib/api";
import { Board } from "./Board";
import { History } from "./History";

type Tab = "open" | "history";
type HistoryStatus = "idle" | "loading" | "ready" | "unauthorized" | "error";

export function YoursPanel({
  holdings,
  now,
  loading,
  signedIn,
}: {
  holdings: Holding[];
  now: number;
  loading: boolean;
  /** Whether an account is signed in (ADR-0017) -- gates the History tab, not the Open one. */
  signedIn: boolean;
}) {
  const [tab, setTab] = useState<Tab>("open");
  const [status, setStatus] = useState<HistoryStatus>("idle");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // `status` must stay OUT of the deps below. It used to be in them, and the effect sets
  // it to "loading" itself -- so React tore the effect down mid-flight, the cleanup set
  // `cancelled`, and the request's own .then/.catch both bailed. It spun forever.
  useEffect(() => {
    if (tab !== "history") return;
    if (!signedIn) {
      setStatus("unauthorized");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    getHistory()
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRefusal && e.status === 401) {
          setStatus("unauthorized");
        } else {
          // A refusal carries a sentence worth showing. Anything else is a dead or
          // unreachable API, where the browser's own "Failed to fetch" helps nobody.
          setError(e instanceof ApiRefusal ? e.message : "Could not reach the server.");
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab, signedIn]);

  return (
    <div className="yours-panel">
      <div className="yours-tabs" role="tablist" aria-label="Open or History">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "open"}
          data-testid="yours-tab-open"
          onClick={() => setTab("open")}
        >
          Open
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          data-testid="yours-tab-history"
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "open" ? (
        <Board holdings={holdings} now={now} loading={loading} />
      ) : status === "unauthorized" ? (
        <p className="yours-signin-note" data-testid="history-signin-gate">
          Sign in to see your history.
        </p>
      ) : status === "error" ? (
        <p className="loading" role="alert" data-testid="history-error">
          {error ?? "Could not load your history."}
        </p>
      ) : (
        <History items={items} loading={status === "loading" || status === "idle"} />
      )}
    </div>
  );
}
