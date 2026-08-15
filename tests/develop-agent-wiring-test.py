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
prompts = json.loads((root / "tests" / "fixtures" / "develop-agent" / "prompts.json").read_text())
assert len(prompts) == 5
assert all("hardware_sensitive_facts" in prompt and "citation token returned" in prompt for prompt in prompts.values())
assert all("Do not delegate" in prompt and "this session" in prompt for prompt in prompts.values())
assert all("call labwired_context again" in prompt and "before compiling" in prompt for prompt in prompts.values())
assert all("Use labwired_compile" in prompt and "not a shell compile" in prompt for prompt in prompts.values())
assert "call labwired_verify directly" in prompts["greenfield-esp32c3"]
assert "do not start with labwired_run" in prompts["greenfield-esp32c3"]
assert "output summary" in prompts["greenfield-esp32c3"]
assert "never request full" in prompts["greenfield-esp32c3"]
assert "call labwired_verify directly" in prompts["existing-stm32f103"]
assert "output summary" in prompts["existing-stm32f103"]
for name in ("greenfield-esp32c3", "existing-stm32f103", "compile-recovery-esp32c3", "partial-led-wifi"):
    assert "use the exact catalog:board:" in prompts[name].lower()
print("ok   develop-agent wiring")
