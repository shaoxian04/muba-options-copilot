"""Persistence for StrategyDefinitions (Step 5).

File-backed today, Supabase later. Callers depend only on the
StrategyStore Protocol, never on FileStrategyStore's constructor or file,
so swapping in a Supabase store later is one new class, not a rewrite of
strategy_cli.py or evaluate.py.

owner_id is a placeholder, not a verified identity, this project has no
auth yet (see apps/api/src/sessions.ts). Single-process only: no file
locking, two writers racing on strategies.json is a known gap, fine for
a local CLI, not for a concurrent server.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from pydantic import ValidationError

from strategy.schema import StrategyDefinition

DEFAULT_STORE_PATH = Path(__file__).resolve().parents[1] / "data" / "strategies.json"


class StrategyStore(Protocol):
    """What downstream code is allowed to depend on. No file, table, or
    connection mentioned here, that's the point.
    """

    def save(self, owner_id: str, strategy: StrategyDefinition) -> StrategyDefinition:
        """Store `strategy` under `owner_id`, return the stored form (server
        generates id/owner_id, see FileStrategyStore.save).
        """
        ...

    def list(self, owner_id: str) -> list[StrategyDefinition]:
        ...

    def get(self, strategy_id: str) -> StrategyDefinition | None:
        ...

    def delete(self, strategy_id: str) -> bool:
        ...

    def set_enabled(self, strategy_id: str, enabled: bool) -> StrategyDefinition | None:
        ...


class CorruptStrategyStoreError(RuntimeError):
    """One entry in the backing file failed validation on load. Raised
    immediately, named by id, rather than silently skipped, the file is
    hand-editable so a mangled entry is a real failure mode.
    """


class FileStrategyStore:
    """JSON-file-backed StrategyStore. One file, one JSON array of every
    StrategyDefinition ever saved across all owners, owner_id is a field
    on each record, not a partition of the file.
    """

    def __init__(self, path: Path | str = DEFAULT_STORE_PATH) -> None:
        self._path = Path(path)

    # internal: load/save the whole file

    def _load_raw(self) -> list[dict]:
        if not self._path.exists():
            return []
        text = self._path.read_text(encoding="utf-8")
        if not text.strip():
            return []
        return json.loads(text)

    def _load_all(self) -> list[StrategyDefinition]:
        """Every record, re-validated on every load (not just write time), that's
        what catches a hand-edited file.
        """
        records = self._load_raw()
        strategies: list[StrategyDefinition] = []
        for record in records:
            bad_id = record.get("id", "<no id field>") if isinstance(record, dict) else "<non-object entry>"
            try:
                strategies.append(StrategyDefinition.model_validate(record))
            except ValidationError as exc:
                raise CorruptStrategyStoreError(
                    f"strategies.json entry {bad_id!r} failed validation on load: {exc}"
                ) from exc
        return strategies

    def _write_all(self, strategies: list[StrategyDefinition]) -> None:
        """Atomic write: build in a temp sibling, then os.replace() over the
        target, so a process killed mid-write leaves the old file or the
        new one, never a half-written JSON array.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps([s.model_dump(mode="json") for s in strategies], indent=2)

        fd, tmp_name = tempfile.mkstemp(
            dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.replace(tmp_name, self._path)
        except BaseException:
            # best-effort cleanup, worst case this leaks a .tmp file, never corrupts the real one
            try:
                os.remove(tmp_name)
            except OSError:
                pass
            raise

    # StrategyStore

    def save(self, owner_id: str, strategy: StrategyDefinition) -> StrategyDefinition:
        """Incoming id and owner_id are never trusted, both get overwritten
        with a server-generated id and the owner_id argument, so a
        caller-supplied owner can never stick.

        uuid4() rather than a timestamp or counter, same class of bug
        sessions.ts already had to fix (Date.now()+Math.random() isn't
        collision-free, a counter is guessable and racy without a lock).
        """
        stored = strategy.model_copy(update={"id": str(uuid4()), "owner_id": owner_id})
        strategies = self._load_all()
        strategies.append(stored)
        self._write_all(strategies)
        return stored

    def list(self, owner_id: str) -> list[StrategyDefinition]:
        return [s for s in self._load_all() if s.owner_id == owner_id]

    def get(self, strategy_id: str) -> StrategyDefinition | None:
        for s in self._load_all():
            if s.id == strategy_id:
                return s
        return None

    def delete(self, strategy_id: str) -> bool:
        strategies = self._load_all()
        remaining = [s for s in strategies if s.id != strategy_id]
        if len(remaining) == len(strategies):
            return False
        self._write_all(remaining)
        return True

    def set_enabled(self, strategy_id: str, enabled: bool) -> StrategyDefinition | None:
        strategies = self._load_all()
        updated: StrategyDefinition | None = None
        for i, s in enumerate(strategies):
            if s.id == strategy_id:
                updated = s.model_copy(update={"enabled": enabled})
                strategies[i] = updated
                break
        if updated is None:
            return None
        self._write_all(strategies)
        return updated
