"""The Decision log: what a Trader actually did with a Suggestion (Step 6).

ACCEPTED does not mean a trade happened, it means the Trader chose to carry
this Suggestion forward to /propose, where the backend re-derives every
number and a human still confirms before any signature. Recording a
Decision here is as inert as a chat log, it's a note about what the Trader
chose, never an act of choosing on their behalf. Easy to misread, so it's
said again on record() below.

Same file-backed-today/Supabase-later shape as strategy/store.py: callers
depend on the DecisionLogStore Protocol, not on FileDecisionLog's file.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, ValidationError

from strategy.schema import Then
from strategy.suggest import Suggestion

DEFAULT_DECISIONS_PATH = Path(__file__).resolve().parents[1] / "data" / "decisions.json"

DecisionType = Literal["ACCEPTED", "DISMISSED"]


class Decision(BaseModel):
    """One historical fact: this Trader made this choice about this firing,
    at this time. Nothing here is re-derived later, see record() for why
    `then` is snapshotted rather than joined.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    owner_id: str
    strategy_id: str
    strategy_name: str
    fired_at: datetime
    # snapshotted, not a foreign key to strategy/store.py. a Decision must
    # remember the Trade Intent the Trader actually saw, the strategy can be
    # edited or deleted after this is recorded, and a log that disagrees
    # with what was shown is worse than no log.
    then: Then
    decision: DecisionType
    decided_at: datetime


class DecisionLogStore(Protocol):
    """What suggest_cli.py is allowed to depend on. No file, table, or
    connection mentioned here.
    """

    def record(self, owner_id: str, suggestion: Suggestion, decision: DecisionType) -> Decision:
        ...

    def list(self, owner_id: str, strategy_id: str | None = None) -> list[Decision]:
        ...

    def stats(self, owner_id: str, strategy_id: str | None = None) -> dict[str, "StrategyStats"]:
        ...


class StrategyStats(BaseModel):
    """Per-strategy accept/dismiss counts, keyed by strategy_id. accept_rate
    is None rather than 0.0 with zero decisions, unjudged isn't the same as
    always-dismissed.
    """

    model_config = ConfigDict(extra="forbid")

    strategy_name: str
    accepted: int
    dismissed: int
    accept_rate: float | None


class CorruptDecisionLogError(RuntimeError):
    """Mirrors store.py's CorruptStrategyStoreError, a bad entry is surfaced
    by id, never silently dropped.
    """


class FileDecisionLog:
    """JSON-file-backed DecisionLogStore, same shape as FileStrategyStore.

    Append-only: every method reads the whole file or appends and rewrites,
    nothing mutates or removes an existing record by id. A Decision is a
    record of what happened, not something to correct in place.
    """

    def __init__(self, path: Path | str = DEFAULT_DECISIONS_PATH) -> None:
        self._path = Path(path)

    # internal: load/save the whole file, same pattern as store.py

    def _load_raw(self) -> list[dict]:
        if not self._path.exists():
            return []
        text = self._path.read_text(encoding="utf-8")
        if not text.strip():
            return []
        return json.loads(text)

    def _load_all(self) -> list[Decision]:
        records = self._load_raw()
        decisions: list[Decision] = []
        for record in records:
            bad_id = record.get("id", "<no id field>") if isinstance(record, dict) else "<non-object entry>"
            try:
                decisions.append(Decision.model_validate(record))
            except ValidationError as exc:
                raise CorruptDecisionLogError(
                    f"decisions.json entry {bad_id!r} failed validation on load: {exc}"
                ) from exc
        return decisions

    def _write_all(self, decisions: list[Decision]) -> None:
        """Atomic write, same technique as FileStrategyStore._write_all."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps([d.model_dump(mode="json") for d in decisions], indent=2)

        fd, tmp_name = tempfile.mkstemp(
            dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.replace(tmp_name, self._path)
        except BaseException:
            try:
                os.remove(tmp_name)
            except OSError:
                pass
            raise

    # DecisionLogStore

    def record(self, owner_id: str, suggestion: Suggestion, decision: DecisionType) -> Decision:
        """Append one Decision and return it. This call alone never spends
        money, calls /fill, or writes a Position, see the module docstring.

        id and decided_at are server-generated, never taken from a caller,
        same reasoning as FileStrategyStore.save.
        """
        stored = Decision(
            id=str(uuid4()),
            owner_id=owner_id,
            strategy_id=suggestion.strategy_id,
            strategy_name=suggestion.strategy_name,
            fired_at=suggestion.fired_at.to_pydatetime()
            if hasattr(suggestion.fired_at, "to_pydatetime")
            else suggestion.fired_at,
            then=suggestion.then,
            decision=decision,
            decided_at=datetime.now(timezone.utc),
        )
        decisions = self._load_all()
        decisions.append(stored)
        self._write_all(decisions)
        return stored

    def list(self, owner_id: str, strategy_id: str | None = None) -> list[Decision]:
        decisions = [d for d in self._load_all() if d.owner_id == owner_id]
        if strategy_id is not None:
            decisions = [d for d in decisions if d.strategy_id == strategy_id]
        return decisions

    def stats(self, owner_id: str, strategy_id: str | None = None) -> dict[str, StrategyStats]:
        """One StrategyStats per strategy_id seen, keyed by strategy_id.
        strategy_name comes from the most recent Decision so a renamed
        strategy still shows a name.
        """
        decisions = self.list(owner_id, strategy_id)
        by_strategy: dict[str, StrategyStats] = {}
        for d in decisions:
            existing = by_strategy.get(d.strategy_id)
            accepted = (existing.accepted if existing else 0) + (1 if d.decision == "ACCEPTED" else 0)
            dismissed = (existing.dismissed if existing else 0) + (1 if d.decision == "DISMISSED" else 0)
            total = accepted + dismissed
            by_strategy[d.strategy_id] = StrategyStats(
                strategy_name=d.strategy_name,
                accepted=accepted,
                dismissed=dismissed,
                accept_rate=(accepted / total) if total else None,
            )
        return by_strategy
