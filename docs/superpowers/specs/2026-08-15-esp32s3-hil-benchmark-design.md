# ESP32-S3 HIL Benchmark Design

**Date:** 2026-08-15

## Objective

Build the first end-to-end Twin2Silicon hardware-in-the-loop repair benchmark on the connected ESP32-S3. A model run is successful only when its candidate firmware builds, flashes to the intended board, emits a run-specific UART nonce, and leaves the physical GPIO peripheral in the hidden oracle's expected state as observed through USB-JTAG.

This specification covers one reusable evaluator and one task, `esp32s3-gpio-hil-001`. A larger task suite, scheduled lab service, and multi-model leaderboard are separate follow-on work.

## Task

The public task is an ESP-IDF C firmware project built through PlatformIO. It contains one realistic GPIO configuration defect and a concise repair prompt. The model may modify only the copied public workspace. The task's hidden descriptor contains:

- the board profile and PlatformIO environment;
- the expected USB-JTAG serial identity, supplied by evaluator configuration rather than model context;
- the UART device-selection rule and baud rate;
- the flash artifact location;
- a GPIO register read plan with address, mask, and expected masked value;
- build, flash, UART, JTAG, wall-time, token, and iteration limits.

The evaluator injects a cryptographically random run nonce into a generated header before the model starts. Correct firmware prints `LABWIRED_READY:<nonce>`. A fixed string or output from an earlier run cannot satisfy the UART oracle.

## Architecture

The implementation consists of four focused units:

1. **Task runner.** Creates a run directory and isolated public workspace, injects the nonce, invokes the existing public LabWired Agent, enforces model budgets, and records provider usage.
2. **Build and flash adapter.** Runs pinned PlatformIO commands, identifies the produced firmware, flashes only after board identity validation, and preserves command logs and exit metadata.
3. **UART/JTAG HIL evaluator.** Acquires an exclusive board lock, validates the expected Espressif USB-JTAG adapter, captures UART until the nonce or timeout, halts the target with Espressif OpenOCD, reads the hidden GPIO register plan, and evaluates masked values.
4. **Evidence writer.** Produces one canonical result manifest plus immutable raw logs and SHA-256 hashes.

The runner orchestrates these units in this order:

```text
prepare workspace
  -> model repair
  -> clean build
  -> acquire board lock
  -> validate board identity
  -> start UART capture
  -> flash and reset
  -> observe nonce
  -> halt and read GPIO registers
  -> evaluate oracle
  -> release board lock
  -> write evidence
```

Simulator scoring remains a separate field. It may be `not_supported` for this first ESP-IDF task and cannot substitute for the physical HIL result.

## Hardware Safety and Identity

The evaluator is destructive to the board's installed firmware, as explicitly authorized. It must not operate on an ambiguous target.

- The expected USB-JTAG serial is an explicit evaluator input. The currently connected S3 reports `9C:CC:01:D0:98:E0`, but the repository does not treat that machine-specific value as a universal default.
- Zero or multiple matching adapters produces `infrastructure_error`; the evaluator does not flash.
- UART selection must resolve to exactly one device associated with the target profile. A CLI override is allowed for laboratory setup and is recorded in redacted form in the manifest.
- A filesystem lock keyed by board identity prevents concurrent flash/JTAG runs. Lock acquisition has a timeout and records contention as infrastructure failure.
- Every subprocess has a hard timeout and process-group cleanup. Signal handling releases ports, OpenOCD, and the board lock.

## Result Contract

The canonical `run.json` records:

- schema, run, task, harness, and model identifiers;
- model request count, fresh/cached/output/reasoning tokens, final context size, latency, and estimated provider cost;
- configured budgets and whether each was respected;
- `model_status`, `compile_status`, `simulator_status`, `hardware_status`, and `infrastructure_status` as independent fields;
- UART nonce result and JTAG register assertions without exposing hidden expectations to the model;
- termination reason and normalized failure category;
- hashes for the candidate source tree, firmware, oracle descriptor, raw logs, and evaluator result.

`hardware_status` is `pass` only when the clean build, flash, nonce, and every required register assertion pass. Missing tools, missing hardware, ambiguous identity, port contention, and transport failure are `infrastructure_error`, never model failures. A candidate that builds and flashes but misses the nonce or register oracle is `fail`.

The runner exits zero only for a valid completed evaluation, whether the model passes or fails. It uses a distinct nonzero exit for invalid or incomplete infrastructure runs so batch aggregation cannot silently count them.

## Evidence and Reproducibility

Each run directory contains the public prompt, initial and final source hashes, exact harness revision, sanitized tool versions, model/provider identity, budgets, command timing, raw build/flash/UART/OpenOCD logs, parsed register observations, `run.json`, and `cost.json`.

Secrets, bearer tokens, full environment dumps, and hidden oracle values are not copied into model-visible files. Published results may include the oracle after the evaluation set is retired; active hidden tasks publish only schema and aggregate assertion outcomes.

Pricing is versioned with source URL, effective date, and fresh-input, cached-input, and output rates. Cost remains an estimate unless reconciled against a provider invoice.

## Testing

Offline tests drive the real orchestration boundary with fixture executables for PlatformIO, serial capture, and OpenOCD. They cover:

- a complete pass;
- compilation and flash failures;
- absent, incorrect, and stale UART nonces;
- incorrect GPIO masked values;
- absent, wrong, and ambiguous board identity;
- UART, JTAG, and lock timeouts;
- subprocess interruption and cleanup;
- correct separation of model failure and infrastructure error;
- stable JSON schema, evidence hashes, and cost arithmetic.

Tests are written before production behavior and must demonstrate the expected red failure before implementation. The live acceptance test is opt-in, names the target serial and UART explicitly, overwrites the board firmware, and is excluded from ordinary CI. Acceptance requires one fresh physical run that produces the nonce and passing GPIO register evidence.

## Non-Goals

This first increment does not add external voltage or waveform instrumentation, continuous unattended lab scheduling, automatic firmware restoration, more than one task, or GPT/Claude/Grok comparison runs. Those additions build on the evaluator contract after the connected ESP32-S3 path is proven.

