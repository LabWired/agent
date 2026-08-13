#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CASES="$ROOT/fixtures/develop-acceptance/cases.json"
RESPONSE="${1:-$ROOT/fixtures/develop-acceptance/expected-response.json}"

python3 - "$CASES" "$RESPONSE" <<'PY'
import json, pathlib, sys

cases_path, response_path = map(pathlib.Path, sys.argv[1:])
cases = json.loads(cases_path.read_text())
response = json.loads(response_path.read_text())

assert len(cases["scenarios"]) == 5, "exactly five acceptance scenarios required"
assert {c["id"] for c in cases["scenarios"]} == {
    "greenfield-esp32c3", "existing-stm32f103", "compile-recovery-esp32c3",
    "partial-led-wifi", "unsupported-custom-board",
}
reports = {r["id"]: r for r in response["reports"]}
assert set(reports) == {c["id"] for c in cases["scenarios"]}

for case in cases["scenarios"]:
    report = reports[case["id"]]
    assert report["attempts"] <= 3, f'{case["id"]}: exceeded three total attempts'
    assert report["compile"] in {"passed", "failed", "not_run"}
    assert report["twin_status"] in {"model_verified", "failed", "inconclusive", "unsupported", "not_run"}
    assert report["hardware_status"] in {"hardware_observed", "not_run"}
    if report["twin_status"] == "model_verified":
        assert report["evidence_source"] == "labwired_verify", f'{case["id"]}: invalid model_verified source'
        assert not report["gaps"], f'{case["id"]}: model_verified with coverage gaps'
    if report["hardware_status"] == "hardware_observed":
        assert report["evidence_source"] == "physical_capture", f'{case["id"]}: twin cannot prove hardware'
    if report["compile"] == "passed" and report["evidence_source"] == "compile":
        assert report["twin_status"] != "model_verified", f'{case["id"]}: compile promoted to model_verified'

green = reports["greenfield-esp32c3"]
assert green["compile"] in {"passed", "not_run"}
assert all(v == "checked" or k in green["gaps"] for k, v in green["behaviors"].items())

stm = reports["existing-stm32f103"]
assert stm["compile"] in {"passed", "not_run"} and stm["layout_preserved"] is True
assert stm["build_command"] == cases["scenarios"][1]["input"]["build_command"]
assert stm["behaviors"]["heartbeat"] == "checked" or "heartbeat" in stm["gaps"]

recovery = reports["compile-recovery-esp32c3"]
if recovery["compile"] == "not_run":
    assert recovery["attempts"] == 1 and recovery["compile_history"] == [{"status": "not_run"}]
    assert "compile_recovery" in recovery["gaps"]
else:
    assert recovery["attempts"] in {2, 3}
    assert recovery["compile_history"][0]["status"] == "failed"
    assert recovery["compile_history"][-1]["status"] == "passed"
    assert recovery["compile_history"][1]["diagnostic_removed"] == cases["scenarios"][2]["input"]["diagnostic"]

partial = reports["partial-led-wifi"]
assert partial["behaviors"]["led_blink"] == "checked" or "led_blink" in partial["gaps"]
assert partial["behaviors"]["wifi_association"] in {"unsupported", "unavailable", "not_observable"}
assert partial["twin_status"] != "model_verified" and "wifi_association" in partial["gaps"]

custom = reports["unsupported-custom-board"]
assert custom["compile"] in {"passed", "not_run"} and custom["twin_status"] in {"unsupported", "not_run"}
assert custom["hardware_status"] == "not_run" and custom["requires_physical_confirmation"] is True
assert custom["claim"] == ("compiled_only" if custom["compile"] == "passed" else "not_run")

print("ok   five develop acceptance contracts")
print("ok   claim boundaries and three-total-attempt limit")
PY
