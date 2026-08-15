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
assert all("hardware_sensitive_facts" in prompt for prompt in prompts.values())
assert all("citation token returned" in prompt or "returned citation token" in prompt or "source must be exactly" in prompt for prompt in prompts.values())
assert all("Do not delegate" in prompt and "this session" in prompt for prompt in prompts.values())
assert all("call labwired_context again" in prompt and "before compiling" in prompt for prompt in prompts.values())
assert all("Use labwired_compile" in prompt and "not a shell compile" in prompt for prompt in prompts.values())
assert "labwired_verify directly" in prompts["greenfield-esp32c3"]
assert "do not start with labwired_run" in prompts["greenfield-esp32c3"]
assert "output summary" in prompts["greenfield-esp32c3"]
assert "never request full" in prompts["greenfield-esp32c3"]
assert "labwired_verify directly" in prompts["existing-stm32f103"]
assert "output summary" in prompts["existing-stm32f103"]
assert "max_steps 50000000" in prompts["existing-stm32f103"]
assert "no external LED part" in prompts["existing-stm32f103"]
assert 'source must be exactly catalog:board:esp32-c3-supermini' in prompts["greenfield-esp32c3"]
assert 'source must be exactly catalog:board:stm32f103-blinky' in prompts["existing-stm32f103"]
assert 'source must be exactly catalog:board:esp32-c3-supermini' in prompts["compile-recovery-esp32c3"]
stm32_prompt = prompts["existing-stm32f103"]
for required in (
    "edit only the existing src/main.cpp in place",
    "do not add, remove, or rename files",
    "leave platformio.ini byte-identical",
):
    assert required in stm32_prompt
recovery_prompt = prompts["compile-recovery-esp32c3"]
for required in (
    "The project already contains the deliberate error in src/main.cpp; do not overwrite or replace it before the first compile.",
    "After the failed compile, use the edit tool on src/main.cpp for one focused repair",
    "compile the exact repaired file content",
):
    assert required in recovery_prompt
partial_prompt = prompts["partial-led-wifi"]
for required in (
    "upload the complete project with labwired_put_source",
    "compile its returned source_tree_ref",
    "target esp32-c3-supermini and the returned flash_image_refs",
    "serial contains `Connecting to Wi-Fi` plus GPIO8 toggled",
    'refresh context with exactly pack.board `esp32-c3-supermini` and pack.mcu `esp32c3`',
    "do not include false context flags",
):
    assert required in partial_prompt
unsupported_prompt = prompts["unsupported-custom-board"]
for required in (
    "nucleo-f401re only as a compiler surrogate",
    "attempt labwired_verify with target custom-board",
    "Physical confirmation is still required",
    '"hardware_sensitive_facts":[{"fact":"PA5 is the surrogate board LED pin","source":"catalog:board:nucleo-f401re"}]',
):
    assert required in unsupported_prompt
assert 'source must be exactly catalog:board:esp32-c3-supermini' in prompts["partial-led-wifi"]
for name in ("greenfield-esp32c3", "existing-stm32f103", "compile-recovery-esp32c3", "partial-led-wifi"):
    assert "GPIO oracle state must be toggled" in prompts[name]
    assert "never high or low" in prompts[name]
print("ok   develop-agent wiring")
