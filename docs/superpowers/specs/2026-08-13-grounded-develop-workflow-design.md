# Grounded Develop Workflow — Release Design

**Date:** 2026-08-13  
**Status:** Approved design  
**Scope:** Release-now firmware development workflow for LabWired Agent

## Goal

Ship a hardware-aware firmware development workflow now, accepting limited reliability where hardware knowledge or virtual-hardware coverage is incomplete.

The workflow must support both greenfield requests and existing firmware repositories:

```text
inspect or scaffold
  → ground available hardware facts
  → edit firmware
  → compile
  → run applicable virtual-hardware checks
  → diagnose and repair
  → report evidence and gaps
```

The primary product job is firmware development. The LabWired twin is an always-available virtual-hardware check within that workflow, not a separate destination and not a substitute for physical-hardware evidence.

## Product Position

LabWired Agent should provide the workflow users expect from hardware-aware firmware agents:

- Understand the board and existing project.
- Use datasheets, board definitions, schematics, register information, and SDK definitions when available.
- Write framework-native firmware.
- Compile with the project's real toolchain.
- Exercise supported behavior on virtual hardware.
- Repair failures autonomously.
- State exactly what was and was not verified.

The release may degrade gracefully when grounding or model coverage is incomplete. It must not convert missing coverage, inference, compilation, or an ordinary run into a verification claim.

## Release Architecture

Keep the implementation small:

- One strong `develop` workflow skill directs the sequence.
- Existing `labwired_*` tools perform catalog, context, import, compile, run, inspect, and verify operations.
- Existing tool statuses and claim rules provide the deterministic gates; no new orchestrator is introduced.
- There is no general workflow engine, state-machine framework, or new persistence system in this release.

The workflow runs autonomously by default. It stops when acceptance checks pass, three total edit-and-test attempts have completed without success, the user cancels, or no new evidence supports the next allowed attempt. There is no fourth attempt.

The normal tool sequence is `labwired_context` → knowledge tools as needed → `labwired_compile` → `labwired_run` / `labwired_inspect` → `labwired_verify`. Circuit import tools are used only when the request includes circuit input. If a tool is unavailable, report that gap rather than replacing it with model judgment.

## Workflow

### 1. Inspect or scaffold

For an existing repository, inspect its structure and detect the board or MCU, framework, SDK, toolchain, and build command without replacing established conventions.

For a greenfield request, identify the requested hardware and framework, then scaffold the smallest conventional project that can satisfy the request.

When a required choice cannot be discovered safely, ask the user. Do not invent a target board, MCU variant, programmer, or electrical connection.

### 2. Ground hardware-sensitive decisions

Before hardware-sensitive edits, retrieve the best available context from:

- LabWired board and part catalog data
- `.labwired/lab.yaml` and imported circuit information
- Datasheets and reference manuals
- SVD register definitions
- Schematics and netlists
- Vendor SDK headers and existing project definitions

Prefer vendor SDK, HAL, framework, and symbolic register definitions over handwritten numeric constants. For important hardware choices—pins, peripheral instances, addresses, clocks, timing limits, and register fields—the final report names the value and its catalog ID, document section, schematic/netlist location, SVD symbol, SDK symbol, or project file. Reasonable deductions may be used when required for progress, but they are labeled `inferred`.

Conflicting sources are not silently reconciled. Prefer project-specific wiring over generic development-board defaults, and report material conflicts that affect behavior.

Grounding is best-effort for this release. Missing context does not block unrelated work.

### 3. Edit and compile

Make focused changes that preserve the repository's structure and style. Run the project's actual build command after changes.

If compilation fails, use compiler diagnostics and grounded project context to make a targeted repair. Do not rewrite working subsystems without evidence that they caused the failure.

### 4. Check on virtual hardware

After a successful compile, turn each observable behavior in the request into a twin check when supported. Use `labwired_verify` for assertions and `labwired_run` plus `labwired_inspect` for observations. Anything else becomes an explicit coverage gap. A workflow may not say “tested” if it ran no checks.

Unsupported peripherals or behaviors do not fail otherwise valid checks. They are recorded as coverage gaps requiring physical confirmation.

Only `labwired_verify` may produce `model_verified`. A compile or ordinary twin run is an observation, not verification.

### 5. Diagnose and repair

When compilation or supported virtual-hardware checks fail, diagnose from concrete evidence and repair the smallest relevant surface.

The limit is three total edit-and-test attempts, including the initial implementation. The workflow stops after the third unsuccessful result and reports the remaining blocker.

### 6. Report

Every completed workflow returns a short report with five headings:

- **Changed** — files and behavior changed
- **Grounded by** — important hardware values and their sources, including labeled inferences
- **Compiled** — command and result
- **Twin checked** — behaviors observed or `model_verified`
- **Still needs hardware** — unsupported, unavailable, or non-observable behavior

The report ends with one overall result: `verified`, `partially verified`, `compiled only`, `failed`, or `blocked`.

`hardware_observed` remains exclusive to evidence from a physical-board workflow. Twin evidence must never be presented as physical evidence.

## Failure and Degraded Modes

The workflow remains useful under partial availability:

- **Knowledge unavailable:** use repository and SDK context; label hardware assumptions.
- **Datasheet unavailable:** prefer vendor headers and known board definitions; request the document only when essential.
- **Compile toolchain unavailable:** report the missing command or dependency and do not claim compilation.
- **Twin target unavailable:** deliver compile evidence and an explicit physical-confirmation boundary.
- **Partially modeled hardware:** run supported checks and list uncovered behavior.
- **Physical board unavailable:** do not block the virtual workflow and do not claim `hardware_observed`.
- **Repeated failure:** stop after the retry bound and return diagnostics, attempted repairs, and the remaining blocker.

## Release Claims

Acceptable claims:

- Develop firmware with datasheet and board context.
- Compile firmware, attempt supported virtual-hardware checks, and repair observed failures.
- Ground hardware decisions in registers, schematics, and SDK definitions when available.
- See what was tested and what still requires a physical board.

Claims excluded from this release:

- Production-ready firmware without qualification
- No hallucinated registers
- Guaranteed operation on physical hardware
- Full support for every catalog board or peripheral

## Acceptance Tests

The release requires five fixed smoke scenarios:

1. **Greenfield ESP32-C3:** prompt: “Create PlatformIO Arduino firmware for ESP32-C3 DevKitM-1 that blinks the configured LED once per second and prints `alive` over serial.” Expected: compile passes; at least one requested behavior is checked; every unchecked behavior is listed.
2. **Existing STM32F103 project:** start from the checked-in minimal STM32F103 fixture with an established build layout. Prompt: “Add a one-second heartbeat without restructuring the project.” Expected: existing layout and build command remain; compile passes; a supported heartbeat observation or explicit coverage gap is present.
3. **Compile recovery ESP32-C3:** start from scenario 1 with one deliberate compiler error. Expected: the first compile fails, a focused repair removes that diagnostic, and a later compile passes within three total attempts.
4. **Partial coverage ESP32-C3:** prompt requests LED blink plus Wi-Fi association. Expected: supported LED behavior is verified or observed; Wi-Fi is recorded as `unsupported`, `unavailable`, or `not_observable`; workflow is not reported as fully `verified` unless both behaviors are checked.
5. **Unsupported custom board:** use a minimal buildable repository whose board is absent from the LabWired target catalog. Expected: the report says `compiled only` at best and requires physical confirmation.

Tests must also confirm that compilation alone never yields `model_verified`, twin results never yield `hardware_observed`, and missing coverage never becomes a passing assertion.

## Non-Goals

- Building a general-purpose orchestration platform
- Matching Embedder's UI or instrument catalog
- Requiring physical hardware for the default workflow
- Blocking all work when a source or model is incomplete
- Broad reliability certification before release
- Replacing established project toolchains with a LabWired-specific build system

## Follow-up Reliability Work

After release, improve reliability incrementally through typed hardware manifests, stronger register validation, source-conflict handling, pinned toolchains, per-board regression fixtures, and physical-board golden tests. These improvements strengthen the same workflow and do not require redesigning it.
