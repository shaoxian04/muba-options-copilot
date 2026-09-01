#!/usr/bin/env python
"""Save / list / get / delete / enable strategies from the terminal (Step 5).

Manual tool, no server, no LLM. Talks only to the StrategyStore interface,
so this doesn't need to change the day a Supabase-backed store shows up.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# lets `python scripts/strategy_cli.py` run without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pydantic import ValidationError

from strategy.schema import StrategyDefinition
from strategy.store import FileStrategyStore, StrategyStore


def _print_strategy(s: StrategyDefinition) -> None:
    flag = "enabled" if s.enabled else "disabled"
    print(f"{s.id}  [{flag}]  owner={s.owner_id}  {s.name}")
    print(f"    then: {s.then.direction} {s.then.underlying} ${s.then.sizeUsdc:g} "
          f"over {s.then.horizonDays}d, {len(s.when)} condition(s)")


def cmd_save(store: StrategyStore, args: argparse.Namespace) -> None:
    raw = json.loads(Path(args.json_path).read_text(encoding="utf-8"))
    try:
        strategy = StrategyDefinition.model_validate(raw)
    except ValidationError as exc:
        print(f"REJECTED: {args.json_path} is not a valid StrategyDefinition\n{exc}")
        sys.exit(1)

    source_id = strategy.id  # only for the "here's what changed" message below
    stored = store.save(args.owner, strategy)
    print(f"Saved. source id {source_id!r} -> stored id {stored.id!r} (owner={stored.owner_id!r})")


def cmd_list(store: StrategyStore, args: argparse.Namespace) -> None:
    strategies = store.list(args.owner)
    if not strategies:
        print(f"(no strategies for owner {args.owner!r})")
        return
    for s in strategies:
        _print_strategy(s)


def cmd_get(store: StrategyStore, args: argparse.Namespace) -> None:
    s = store.get(args.strategy_id)
    if s is None:
        print(f"(no strategy with id {args.strategy_id!r})")
        return
    print(s.model_dump_json(indent=2))


def cmd_delete(store: StrategyStore, args: argparse.Namespace) -> None:
    ok = store.delete(args.strategy_id)
    print("Deleted." if ok else f"(no strategy with id {args.strategy_id!r})")


def cmd_enable(store: StrategyStore, args: argparse.Namespace, enabled: bool) -> None:
    s = store.set_enabled(args.strategy_id, enabled)
    if s is None:
        print(f"(no strategy with id {args.strategy_id!r})")
        return
    _print_strategy(s)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", type=Path, default=None,
                         help="Override the strategies.json path (default: apps/agents/data/strategies.json)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_save = sub.add_parser("save", help="Validate and store a StrategyDefinition JSON file")
    p_save.add_argument("json_path", type=Path)
    p_save.add_argument("--owner", required=True)

    p_list = sub.add_parser("list", help="List strategies for one owner")
    p_list.add_argument("--owner", required=True)

    p_get = sub.add_parser("get", help="Print one strategy by stored id")
    p_get.add_argument("strategy_id")

    p_delete = sub.add_parser("delete", help="Delete one strategy by stored id")
    p_delete.add_argument("strategy_id")

    p_enable = sub.add_parser("enable", help="Set enabled=true on a strategy")
    p_enable.add_argument("strategy_id")

    p_disable = sub.add_parser("disable", help="Set enabled=false on a strategy")
    p_disable.add_argument("strategy_id")

    args = parser.parse_args()
    store = FileStrategyStore(args.path) if args.path else FileStrategyStore()

    if args.command == "save":
        cmd_save(store, args)
    elif args.command == "list":
        cmd_list(store, args)
    elif args.command == "get":
        cmd_get(store, args)
    elif args.command == "delete":
        cmd_delete(store, args)
    elif args.command == "enable":
        cmd_enable(store, args, enabled=True)
    elif args.command == "disable":
        cmd_enable(store, args, enabled=False)


if __name__ == "__main__":
    main()
