---
name: develop
description: Default firmware workflow for greenfield and existing projects: inspect, ground hardware facts, edit, compile, check on twin, repair, report.
license: MIT
compatibility: opencode
metadata:
  gate: workflow
  labwired: true
  pack: develop
---

# Develop firmware

Follow this loop: inspect or scaffold → ground → edit → compile → twin check → repair → report.

Rules:

- Call `labwired_context` first. Before asserting pins, peripherals, addresses, clocks, timing, or registers, ground facts with `labwired_part`, `labwired_datasheet`, or `labwired_search`. Prefer project and SDK symbols; label unresolved deductions as inferred.
- Preserve an existing project's structure. For greenfield work, create the smallest conventional project that satisfies the request.
- Compile with `labwired_compile` or the project's existing compile command.
- After a successful compile, convert every observable requested behavior into `labwired_verify`, or use `labwired_run` plus `labwired_inspect`. Make coverage gaps explicit, and never say tested when no check ran.
- Allow at most three total edit-and-test attempts, including the initial attempt. Use failures to make focused repairs.
- Only `labwired_verify` can mint `model_verified`; only desk hardware may report `hardware_observed`.
- Keep it simple: reuse existing tools and add no new orchestrator.

Report one overall result: `verified`, `partially verified`, `compiled only`, `failed`, or `blocked`. Use exactly these report labels:

## Changed

Files and behavior changed.

## Grounded by

Parts, datasheets, searches, project symbols, and any explicitly inferred facts.

## Compiled

Command, target, outcome, and relevant diagnostics.

## Twin checked

Checks run, observations, coverage, and resulting verification status.

## Still needs hardware

Physical checks, unsupported behavior, and remaining risks.

Smoke scenarios:

- Greenfield ESP32-C3 PlatformIO Arduino: build an LED blink plus alive signal, then compile and twin-check both behaviors.
- Existing STM32F103 heartbeat: retain its structure, make the smallest edit, and do not restructure it.
- Compile recovery ESP32-C3: use compiler diagnostics for focused repair within the three-total-attempt budget.
- Partial coverage ESP32-C3: verify the LED behavior and report Wi-Fi as uncovered and still needing hardware.
- Unsupported custom board: compile successfully, report `compiled only`, and require physical confirmation.
