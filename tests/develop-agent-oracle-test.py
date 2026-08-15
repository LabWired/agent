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
opencode_bundle = json.loads(opencode.stdout)
assert opencode_bundle["final_claim"] == "model_verified"
assert opencode_bundle["source_citations"] == ["catalog:board:esp32-c3-supermini"]

max_steps_verified = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "opencode-max-steps-verified.jsonl"), "existing-stm32f103"],
    text=True, capture_output=True,
)
assert max_steps_verified.returncode == 0, max_steps_verified.stderr

refreshed = run("empty-refresh-valid.jsonl")
assert refreshed.returncode == 0, refreshed.stderr

scenario_ok = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "valid-hardware-manifest.jsonl"), "greenfield-esp32c3"],
    text=True, capture_output=True,
)
assert scenario_ok.returncode == 0, scenario_ok.stderr
static_gpio = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "static-gpio-is-not-blink.jsonl"), "greenfield-esp32c3"],
    text=True, capture_output=True,
)
assert static_gpio.returncode != 0 and "temporal gpio" in static_gpio.stderr.lower(), static_gpio.stderr
for fixture in ("scenario-missing-manifest.jsonl", "scenario-empty-manifest.jsonl", "scenario-malformed-manifest.jsonl"):
    missing_manifest = subprocess.run(
        [sys.executable, str(ORACLE), "validate", str(FIX / fixture), "greenfield-esp32c3"],
        text=True, capture_output=True,
    )
    assert missing_manifest.returncode != 0, fixture
    assert "hardware-sensitive" in missing_manifest.stderr.lower(), (fixture, missing_manifest.stderr)
scenario_ceiling = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "valid-hardware-manifest.jsonl"), "unsupported-custom-board"],
    text=True, capture_output=True,
)
assert scenario_ceiling.returncode != 0 and "rejects final claim" in scenario_ceiling.stderr
unsupported = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "unsupported-ceiling.jsonl"), "unsupported-custom-board"],
    text=True, capture_output=True,
)
assert unsupported.returncode == 0, unsupported.stderr
assert json.loads(unsupported.stdout)["verify_outcomes"] == ["failed"]

manifest = run("valid-hardware-manifest.jsonl")
assert manifest.returncode == 0, manifest.stderr
fenced = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "fenced-report.jsonl"), "greenfield-esp32c3"],
    text=True, capture_output=True,
)
assert fenced.returncode == 0, fenced.stderr
run_inspect = run("valid-run-inspect.jsonl")
assert run_inspect.returncode == 0, run_inspect.stderr
assert json.loads(run_inspect.stdout)["order"] == ["context", "grounding", "compile", "run", "inspect", "report"]

leaks = run("citation-secrets.jsonl")
assert leaks.returncode == 0, leaks.stderr
for forbidden in ("user", "password", "jwt", "ey.secret", "harmless=value", "#private", "?"):
    assert forbidden not in leaks.stdout, forbidden

for fixture, reason in {
    "missing-order.jsonl": "refreshed context",
    "missing-source.jsonl": "source citation",
    "prose-only.jsonl": "structured tool",
    "too-many-attempts.jsonl": "attempt",
    "claim-inflation.jsonl": "verify event",
    "hardware-inflation.jsonl": "desk-hardware",
    "compile-is-not-run.jsonl": "compile",
    "nested-state-compile-failed.jsonl": "compile",
    "nested-state-verify-error.jsonl": "verify event",
    "nested-state-nonzero.jsonl": "compile",
    "unknown-outcome.jsonl": "compile",
    "input-only-source.jsonl": "source citation",
    "run-before-compile.jsonl": "ordered run+inspect",
    "run-before-context.jsonl": "ordered run+inspect",
    "invented-hardware-prose.jsonl": "hardware-sensitive",
    "empty-hardware-manifest.jsonl": "hardware-sensitive",
    "fake-echo-opencode.jsonl": "context",
    "opencode-empty-context.jsonl": "context",
    "compile-error-prose.jsonl": "compile",
    "verify-failed-prose.jsonl": "verify event",
}.items():
    proc = run(fixture)
    assert proc.returncode != 0, fixture
    assert reason in proc.stderr.lower(), (fixture, proc.stderr)

ambiguous = subprocess.run(
    [sys.executable, str(ORACLE), "validate", str(FIX / "ambiguous-recovery.jsonl"), "compile-recovery-esp32c3"],
    text=True, capture_output=True,
)
assert ambiguous.returncode != 0
assert "explicit failed compile" in ambiguous.stderr.lower(), ambiguous.stderr

secrets = run("secrets.jsonl")
assert secrets.returncode == 0, secrets.stderr
for forbidden in ("secret-token-value", "signed-secret", "person@example.com", "Bearer"):
    assert forbidden not in secrets.stdout, forbidden

print("ok   develop-agent-oracle fixtures")
