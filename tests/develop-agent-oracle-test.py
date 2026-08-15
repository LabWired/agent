#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORACLE = ROOT / "tests" / "develop-agent-oracle.py"
FIX = ROOT / "tests" / "fixtures" / "develop-agent"


def run(name):
    return subprocess.run(
        [sys.executable, str(ORACLE), "validate", str(FIX / name)],
        text=True,
        capture_output=True,
    )


valid = run("valid.jsonl")
assert valid.returncode == 0, valid.stderr
bundle = json.loads(valid.stdout)
assert bundle["order"] == ["context", "grounding", "compile", "verify", "report"]
assert bundle["attempt_count"] == 1
assert set(bundle) == {"event_ids", "tool_names", "order", "source_citations", "verify_outcomes", "attempt_count", "final_claim"}

opencode = run("opencode-valid.jsonl")
assert opencode.returncode == 0, opencode.stderr
assert json.loads(opencode.stdout)["final_claim"] == "model_verified"

scenario_ok = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "valid.jsonl"), "greenfield-esp32c3"],
    text=True, capture_output=True,
)
assert scenario_ok.returncode == 0, scenario_ok.stderr
scenario_ceiling = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "valid.jsonl"), "unsupported-custom-board"],
    text=True, capture_output=True,
)
assert scenario_ceiling.returncode != 0 and "rejects final claim" in scenario_ceiling.stderr
unsupported = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "unsupported-ceiling.jsonl"), "unsupported-custom-board"],
    text=True, capture_output=True,
)
assert unsupported.returncode == 0, unsupported.stderr
assert json.loads(unsupported.stdout)["verify_outcomes"] == ["failed"]

for fixture, reason in {
    "missing-order.jsonl": "ordered evidence",
    "missing-source.jsonl": "source citation",
    "prose-only.jsonl": "structured tool",
    "too-many-attempts.jsonl": "attempt",
    "claim-inflation.jsonl": "verify event",
    "hardware-inflation.jsonl": "desk-hardware",
    "compile-is-not-run.jsonl": "verify event",
}.items():
    proc = run(fixture)
    assert proc.returncode != 0, fixture
    assert reason in proc.stderr.lower(), (fixture, proc.stderr)

secrets = run("secrets.jsonl")
assert secrets.returncode == 0, secrets.stderr
for forbidden in ("secret-token-value", "signed-secret", "person@example.com", "Bearer"):
    assert forbidden not in secrets.stdout, forbidden

print("ok   develop-agent-oracle fixtures")
