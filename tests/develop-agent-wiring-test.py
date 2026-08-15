#!/usr/bin/env python3
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
scripts = json.loads((root / "package.json").read_text())["scripts"]
assert scripts["test:develop:mechanics"] == "bash tests/develop-acceptance-smoke.sh"
assert scripts["test:develop:agent"] == "bash tests/develop-agent-e2e.sh"
assert scripts["test:develop:release"] == "LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE=1 bash tests/develop-agent-e2e.sh"

ship = (root / "scripts" / "ship-gate.sh").read_text()
assert "develop-agent-e2e.sh" in ship
assert "LABWIRED_ACCEPTANCE_REQUIRE_COMPLETE" in ship
assert "grounded hosted-agent certification NOT RUN" in ship

mechanics = (root / "tests" / "develop-acceptance-smoke.sh").read_text()
assert "agent_invoked=false" in mechanics
assert "mechanics-only" in mechanics
print("ok   develop-agent wiring")
