# Grounded Develop Workflow — Release Design

**Date:** 2026-08-13  
**Status:** Approved design  
**Scope:** Release-now firmware development workflow for LabWired Agent

## Goal

Ship a dependable, Embedder-class firmware development workflow now, accepting limited reliability where hardware knowledge or virtual-hardware coverage is incomplete.

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

- One strong `develop` workflow skill controls the sequence.
- Existing `labwired_*` tools perform catalog, context, import, compile, run, inspect, and verify operations.
- New deterministic code is added only where needed for project detection, hardware-fact validation, retry bounds, or evidence classification.
- There is no general workflow engine, state-machine framework, or new persistence system in this release.

The workflow runs autonomously by default. It stops when acceptance checks pass, three repair cycles have failed, the user cancels, or no new evidence supports another attempt.

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

Prefer vendor SDK, HAL, framework, and symbolic register definitions over handwritten numeric constants. Facts with sources are treated as grounded. Reasonable deductions may be used when required for progress, but the final report must label them as inferred.

Conflicting sources are not silently reconciled. Prefer project-specific wiring over generic development-board defaults, and report material conflicts that affect behavior.

Grounding is best-effort for this release. Missing context does not block unrelated work.

### 3. Edit and compile

Make focused changes that preserve the repository's structure and style. Run the project's actual build command after changes.

If compilation fails, use compiler diagnostics and grounded project context to make a targeted repair. Do not rewrite working subsystems without evidence that they caused the failure.

### 4. Check on virtual hardware

After a successful compile, automatically run every applicable virtual-hardware check supported by the selected LabWired target. Checks may inspect GPIO, serial output, registers, timing, buses, or display state when those capabilities exist.

Unsupported peripherals or behaviors do not fail otherwise valid checks. They are recorded as coverage gaps requiring physical confirmation.

Only `labwired_verify` may produce `model_verified`. A compile or ordinary twin run is an observation, not verification.

### 5. Diagnose and repair

When compilation or supported virtual-hardware checks fail, diagnose from concrete evidence and repair the smallest relevant surface.

The default limit is three repair cycles. A fourth attempt is allowed only when the latest attempt produced materially new evidence and the next change directly addresses it.

### 6. Report

Every completed workflow returns a compact report that distinguishes:

- Changes made
- Hardware facts used and important inferences
- Compilation result
- Virtual-hardware observations
- Assertions that received `model_verified`
- Behavior not covered by the twin
- Behavior requiring confirmation on a physical board
- Remaining failures or risks

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
- Compile, test on virtual hardware, and repair failures.
- Ground hardware decisions in registers, schematics, and SDK definitions when available.
- See what was tested and what still requires a physical board.

Claims excluded from this release:

- Production-ready firmware without qualification
- No hallucinated registers
- Guaranteed operation on physical hardware
- Full support for every catalog board or peripheral

## Acceptance Tests

The release requires five end-to-end cases:

1. **Greenfield:** create firmware for a named board and framework, compile it, run applicable twin checks, and report evidence.
2. **Existing project:** detect and modify an existing project without replacing its structure, then compile and check it.
3. **Compile recovery:** encounter a deliberate compile failure, diagnose it, make a focused repair, and compile successfully within the retry bound.
4. **Partial twin coverage:** pass supported assertions while reporting an unsupported peripheral or behavior as unverified.
5. **Unsupported hardware:** make useful progress from repository or SDK context and finish with an explicit uncertainty and physical-confirmation report.

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
