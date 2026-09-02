"""Load a StrategyDefinition from JSON, validate it, and print it back.

Manual eyeball check, no evaluation, no fetching, no LLM. Run with the
example, or pass a path to try a different (possibly bad, on purpose)
strategy file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# lets `python scripts/validate_strategy.py` run without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pydantic import ValidationError

from strategy.schema import StrategyDefinition

DEFAULT_EXAMPLE = Path(__file__).resolve().parent.parent / "strategy" / "examples" / "rsi-oversold.json"


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_EXAMPLE
    raw = json.loads(path.read_text())

    strategy = StrategyDefinition.model_validate(raw)
    print(f"OK: {path.name} is a valid StrategyDefinition\n")
    print(strategy.model_dump_json(indent=2))


if __name__ == "__main__":
    try:
        main()
    except ValidationError as exc:
        # exit non-zero rather than a traceback, this runs against
        # in-progress drafts so a readable pydantic error is the useful output
        print(f"REJECTED: {exc}")
        sys.exit(1)
