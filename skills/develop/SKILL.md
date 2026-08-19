---
name: develop
description: >-
  Default firmware workflow for greenfield and existing projects: inspect, ground hardware facts, edit, compile, check on the twin, repair, and report.
license: MIT
metadata:
  gate: "workflow"
  labwired: "true"
  pack: "develop"
---

# Develop firmware

Follow this loop: inspect or scaffold → ground → edit → compile → twin check → repair → report.

Rules:

- Call `labwired_context` first. On `empty_context`, use `labwired_list` + `labwired_describe`, then call `labwired_context` again with `pack.board` and `pack.mcu` from that returned catalog board before compiling; for an external circuit, pass the pack returned by `labwired_import`. A refreshed pack contains only resolved inputs—never copy stale `false`, negative-status, or other output fields into it. This second/refreshed `labwired_context` is mandatory and must succeed with `ok: true` and `design_context_ok: true` before any compile. If refreshed context has `ok: false` or `design_context_ok: false`, do not compile. Cite described boards as exact `catalog:board:<returned board>` sources (and components as `catalog:component:<returned type>`). Prefer `labwired_part`, `labwired_datasheet`, or `labwired_search` for other hardware facts. If those knowledge tools are unavailable, grounded existing project files, SDK headers, SVD files, and schematics or netlists are valid fallback sources; cite the source used. Label missing-source deductions as inferred or as a gap, and never invent pins, peripherals, addresses, clocks, timing, or registers.
- Preserve an existing project's structure. For greenfield work, create the smallest conventional project that satisfies the request.
- Compile with `labwired_compile` or the project's existing compile command.
- Prefer a reviewed, checked-in safe `.labwired/hardware.json` hardware profile
  when the project provides one. Plan before execution and never auto-confirm a
  physical plan digest; the operator must review the exact identities, wiring,
  artifact, and actions.
- After a successful compile, convert every observable requested behavior into `labwired_verify`, or use `labwired_run` plus `labwired_inspect`. Make coverage gaps explicit, and never say tested when no check ran.
- Serial evidence proves only serial behavior; it does not prove a GPIO or LED changed. GPIO/LED behavior requires a passing GPIO oracle clause or modeled GPIO evidence from `labwired_inspect`.
- For temporal GPIO/LED behavior, call `labwired_verify` directly with the firmware and combined oracle; do not start with `labwired_run` or reuse its `run_id`, because edge capture must be armed before execution.
- Use `output: "summary"` for verification evidence; never request `full` unless the user explicitly needs the raw peripheral wall, because large output can hide the verdict behind client truncation.
- Allow at most three total edit-and-test attempts, including the initial attempt. Use failures to make focused repairs.
- Only `labwired_verify` can mint `model_verified`; only `desk-hw` may report `hardware_observed`.
- Keep it simple: reuse existing tools and add no new orchestrator.

Use exactly these report labels:

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

End with one overall result. Use `verified` only when every requested behavior has passing `labwired_verify` / `model_verified` evidence. If some behaviors are only observed or have coverage gaps, cap the result at `partially verified`. If compilation passes but no twin behavior was checked, use `compiled only`. Use `failed` for failures and `blocked` for blockers.

Smoke scenarios:

- Greenfield ESP32-C3 DevKitM-1 with PlatformIO Arduino: blink the configured LED once per second and print `alive` over serial; compile and twin-check both behaviors.
- Existing STM32F103 heartbeat: retain its structure and add a one-second heartbeat without restructuring.
- Compile recovery ESP32-C3: use compiler diagnostics for focused repair within the three-total-attempt budget.
- Partial coverage ESP32-C3: check the LED but leave Wi-Fi association uncovered; full `verified` is forbidden unless both behaviors are checked.
- Unsupported custom board: compile successfully, report `compiled only`, and require physical confirmation.
