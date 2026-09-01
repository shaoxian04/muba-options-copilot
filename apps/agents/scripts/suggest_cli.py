#!/usr/bin/env python
"""Show live Suggestions and record what a Trader did with them (Step 6).

Manual tool, no server, no LLM, no /propose or /fill call. Talks only to
the StrategyStore and DecisionLogStore Protocols.

accept/dismiss record a Decision only, they never spend money, call /fill,
or write a Position (see strategy/decisions.py). ACCEPTED just means the
Trader chose to carry a Suggestion forward to /propose.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# lets `python scripts/suggest_cli.py` run without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strategy.candles import fetch_daily_candles
from strategy.decisions import DecisionLogStore, FileDecisionLog
from strategy.store import FileStrategyStore, StrategyStore
from strategy.suggest import Suggestion, suggestions_for


def _print_suggestion(s: Suggestion) -> None:
    print(f"{s.strategy_id}  {s.strategy_name}  (fired on {s.fired_at.date()})")
    print(f"    then: {s.then.direction} {s.then.underlying} ${s.then.sizeUsdc:g} "
          f"over {s.then.horizonDays}d")


def _fetch_live_suggestions(
    owner_id: str, strategy_store: StrategyStore, symbol: str
) -> tuple[list[Suggestion], list]:
    candles = fetch_daily_candles(symbol=symbol)
    print(f"Fetched {len(candles)} daily candles, "
          f"{candles.index[0].date()} to {candles.index[-1].date()}\n")
    return suggestions_for(owner_id, strategy_store, candles)


def cmd_show(strategy_store: StrategyStore, args: argparse.Namespace) -> None:
    suggestions, errors = _fetch_live_suggestions(args.owner, strategy_store, args.symbol)

    if not suggestions:
        print("(no strategy is firing right now)")
    else:
        for s in suggestions:
            _print_suggestion(s)

    if errors:
        print()
        for e in errors:
            # not folded into "did not fire", unevaluable is unknown, not false
            print(f"COULD NOT EVALUATE  {e.strategy_id}  {e.strategy_name}: {e.error}")


def _find_suggestion(
    owner_id: str, strategy_store: StrategyStore, symbol: str, strategy_id: str
) -> Suggestion | None:
    """re-fetches candles and re-runs evaluation rather than trusting a
    cached Suggestion from a prior `show`, no server here to hold state
    between CLI invocations.
    """
    suggestions, _errors = _fetch_live_suggestions(owner_id, strategy_store, symbol)
    for s in suggestions:
        if s.strategy_id == strategy_id:
            return s
    return None


def _decide(
    strategy_store: StrategyStore,
    decision_store: DecisionLogStore,
    args: argparse.Namespace,
    decision: str,
) -> None:
    suggestion = _find_suggestion(args.owner, strategy_store, args.symbol, args.strategy_id)
    if suggestion is None:
        print(f"(strategy {args.strategy_id!r} is not firing right now -- nothing to {decision.lower()})")
        sys.exit(1)

    recorded = decision_store.record(args.owner, suggestion, decision)
    print(f"Recorded {recorded.decision} for {recorded.strategy_name} ({recorded.strategy_id}) "
          f"at {recorded.decided_at.isoformat()}")
    if decision == "ACCEPTED":
        print("This only means the Suggestion moves forward to /propose -- "
              "no order has been placed and no signature has happened.")


def cmd_list(decision_store: DecisionLogStore, args: argparse.Namespace) -> None:
    decisions = decision_store.list(args.owner, args.strategy_id)
    if not decisions:
        print(f"(no decisions for owner {args.owner!r})")
        return
    for d in decisions:
        print(f"{d.decided_at.isoformat()}  {d.decision:10}  {d.strategy_name} ({d.strategy_id})  "
              f"then: {d.then.direction} {d.then.underlying} ${d.then.sizeUsdc:g}/{d.then.horizonDays}d "
              f"(fired {d.fired_at.date()})")


def cmd_stats(decision_store: DecisionLogStore, args: argparse.Namespace) -> None:
    stats = decision_store.stats(args.owner, args.strategy_id)
    if not stats:
        print(f"(no decisions for owner {args.owner!r})")
        return

    for strategy_id, s in stats.items():
        total = s.accepted + s.dismissed
        rate = f"{s.accept_rate:.0%}" if s.accept_rate is not None else "n/a"
        print(f"{strategy_id}  {s.strategy_name}")
        print(f"    {s.accepted} accepted, {s.dismissed} dismissed, {total} decided -- accept rate {rate}")
        # The payoff line: a strategy dismissed most of the time is a signal
        # the thresholds are wrong, not just a strategy nobody likes.
        if total >= 3 and s.accept_rate is not None and s.accept_rate < 0.34:
            print(f"    -> dismissed most of the time -- consider tightening or "
                  f"retiring this strategy's thresholds")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strategies-path", type=Path, default=None,
                         help="Override strategies.json path")
    parser.add_argument("--decisions-path", type=Path, default=None,
                         help="Override decisions.json path")
    parser.add_argument("--symbol", default="ETHUSDT",
                         help="Binance symbol to fetch candles for (default: ETHUSDT)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_show = sub.add_parser("show", help="Show strategies firing right now")
    p_show.add_argument("--owner", required=True)

    p_accept = sub.add_parser("accept", help="Record ACCEPTED for a currently-firing strategy")
    p_accept.add_argument("strategy_id")
    p_accept.add_argument("--owner", required=True)

    p_dismiss = sub.add_parser("dismiss", help="Record DISMISSED for a currently-firing strategy")
    p_dismiss.add_argument("strategy_id")
    p_dismiss.add_argument("--owner", required=True)

    p_list = sub.add_parser("list", help="List recorded decisions")
    p_list.add_argument("--owner", required=True)
    p_list.add_argument("--strategy-id", dest="strategy_id", default=None)

    p_stats = sub.add_parser("stats", help="Per-strategy accept/dismiss stats")
    p_stats.add_argument("--owner", required=True)
    p_stats.add_argument("--strategy-id", dest="strategy_id", default=None)

    args = parser.parse_args()

    strategy_store = FileStrategyStore(args.strategies_path) if args.strategies_path else FileStrategyStore()
    decision_store = FileDecisionLog(args.decisions_path) if args.decisions_path else FileDecisionLog()

    if args.command == "show":
        cmd_show(strategy_store, args)
    elif args.command == "accept":
        _decide(strategy_store, decision_store, args, "ACCEPTED")
    elif args.command == "dismiss":
        _decide(strategy_store, decision_store, args, "DISMISSED")
    elif args.command == "list":
        cmd_list(decision_store, args)
    elif args.command == "stats":
        cmd_stats(decision_store, args)


if __name__ == "__main__":
    main()
