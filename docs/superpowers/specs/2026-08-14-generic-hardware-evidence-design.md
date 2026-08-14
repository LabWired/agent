# Generic Hardware Evidence Design

**Date:** 2026-08-14
**Status:** Approved design, pending implementation plan
**Scope:** Generic build, twin, physical flash, and behavior evidence for LabWired Agent

## Goal

Make LabWired Agent able to build and verify firmware across supported projects without embedding board-specific behavior in the Agent. Close four release gaps:

1. Native ESP32-C3 Arduino firmware compiles but cannot execute in the current twin.
2. LED and Wi-Fi behaviors lack independent evidence.
3. The VS Code extension test dependency graph contains vulnerable `serialize-javascript` releases.
4. Physical build, flash, and serial acceptance is not a required, reproducible profile-driven gate.

## Principles

- The Agent is target-agnostic. Target details live in explicit project or lab profiles.
- Existing LabWired build, flash, capture, and claim engines remain authoritative.
- Evidence is per behavior. One passing observation cannot cover an unrelated behavior.
- Compilation, model observation, and physical observation are distinct claims.
- A surrogate twin artifact is never presented as same-binary verification.
- Physical actions are explicit, identity-bound, serialized, and fail closed.
- Project configuration is data, not implicitly trusted executable code.
- Secrets never enter profiles, evidence, logs, or model-visible context.

## Architecture

Add a profile-driven orchestration layer over the existing engines:

```text
.labwired/hardware.json
        |
        v
profile parser + validator
        |
        v
trusted adapter registry -----> plan + confirmation digest
        |                              |
        v                              v
build -> optional twin -> physical flash -> observation providers
        |                   |                 |
        +-------------------+-----------------+
                            |
                            v
                   normalized evidence bundle
                            |
                            v
                    behavior-level claims
```

The orchestration runtime is Node.js using only built-in process and filesystem APIs. Node 18 or newer is already a repository requirement and is used by the Agent RPC server. Child processes run through explicit launch descriptors with `shell: false`; Windows PowerShell scripts and command shims are normalized before spawn.

The runner does not replace existing engines:

- `lib/probe.sh` remains the flash authority.
- `lib/serial-capture.sh` remains the serial marker authority.
- `lib/rtt-capture.sh` remains the RTT authority.
- `lib/claim-shape.sh` remains the final claim authority.
- `scripts/dev-cycle.sh` becomes a compatibility wrapper around the profile runner.

## Profile Contract

The default profile path is `.labwired/hardware.json`. A caller may pass another path explicitly. Schema version 1 contains data fields and trusted adapter identifiers:

```json
{
  "schema": 1,
  "target": {
    "id": "desk-c3",
    "chip": "esp32c3",
    "probeSerial": "9C:CC:01:D0:98:E0",
    "serialPort": "/dev/cu.usbmodem101"
  },
  "build": {
    "provider": "platformio",
    "workspace": ".",
    "environment": "esp32-c3-devkitm-1",
    "artifact": ".pio/build/esp32-c3-devkitm-1/firmware.elf"
  },
  "twin": {
    "provider": "labwired-sim",
    "system": "esp32c3",
    "artifactRelation": "exact"
  },
  "flash": {
    "provider": "platformio"
  },
  "observations": [
    {
      "id": "heartbeat",
      "provider": "serial",
      "contains": "alive",
      "timeoutSeconds": 12,
      "requiredLevel": "hardware_observed"
    },
    {
      "id": "led",
      "provider": "logic",
      "channel": 0,
      "edgeCountAtLeast": 2,
      "requiredLevel": "hardware_observed"
    },
    {
      "id": "wifi",
      "provider": "network",
      "deviceMarker": "WIFI_CONNECTED",
      "hostProbeUrlFromMarker": "DEVICE_IP",
      "hostProbePath": "/health",
      "requiredLevel": "hardware_observed"
    }
  ]
}
```

Version 1 trusted providers are deliberately small:

- Build: `platformio`, `make`, `cmake`
- Twin: `labwired-sim`
- Flash: `platformio`, `probe-rs`
- Observation: `serial`, `rtt`, `logic-csv`, `network`

Provider-specific arguments are validated by the adapter. Profiles cannot supply a shell string. Unsupported providers fail during preflight.

An optional `custom` provider may be introduced only as an explicit escape hatch. It requires approval on every run, records its executable and arguments, and can produce only `untrusted_observation`; it cannot satisfy a required verified level.

## Trusted Adapter Boundary

Each adapter has one responsibility and a common interface:

```text
preflight(context) -> capability report
plan(context) -> redacted launch descriptors
execute(context, evidenceDir) -> typed result
```

A launch descriptor contains an executable path, argument array, working directory, redacted environment allowlist, timeout, and cancellation policy. It never contains a shell command.

Adapter lookup is lazy and ordered. Higher-priority explicit paths are resolved before PATH lookup. Windows script launchers return a PowerShell host plus fixed safe arguments rather than attempting direct `.ps1` or `.cmd` execution.

## Evidence Model

Every run creates its evidence directory and a top-level `FAIL` result before preflight. Required records are precreated with `not-run` states so early failure still yields a complete bundle.

The bundle contains:

```text
result.json
plan.json
platform.json
tools.json
build/result.json
build/stdout.txt
build/stderr.txt
twin/result.json
flash/result.json
observations/<behavior-id>/result.json
artifacts/<artifact-name>.sha256
```

Each behavior result uses one of these levels:

- `compiled`: the native artifact was built.
- `model_observed`: the exact native artifact produced the observation in the twin.
- `surrogate_model_observed`: a different artifact sharing declared sources produced a model observation.
- `hardware_observed`: the exact flashed native artifact produced physical evidence.
- `untrusted_observation`: a custom provider reported an observation.
- `blocked`: a required capability, identity, secret, or instrument was absent.
- `failed`: the provider ran and contradicted or failed the assertion.

Each record includes the behavior ID, provider, artifact SHA-256, target identity, start/end timestamps, tool version, bounded raw-evidence references, and redacted diagnostics.

The overall run passes only when every required behavior meets or exceeds its declared level. Levels are not averaged and unrelated observations cannot substitute for each other.

## Evidence Honesty

### Twin

If the twin executes the exact native artifact, the observation may be `model_observed`. If the profile uses a separately built harness or surrogate artifact, the result is `surrogate_model_observed`. The evidence records both hashes and the declared shared-source paths. A surrogate never clears an exact-artifact requirement.

Native firmware may pass strict acceptance without twin support when the exact artifact is physically flashed and all requested behaviors receive adequate physical evidence. This resolves unsupported Arduino runtime formats without weakening the claim.

### GPIO and LED

Serial text and a GPIO output-register read cannot prove a pad toggled. A required physical LED/GPIO behavior needs an independent observation such as logic-analyzer edge capture or another supported external measurement. Register reads may be retained as supporting diagnostics but cannot independently produce `hardware_observed` for the pin.

The initial generic provider accepts normalized logic CSV so it works with different analyzer vendors. Vendor acquisition can occur outside the core runner; the profile identifies channel, time column, value column, minimum edges, and optional frequency bounds.

### Wi-Fi

Wi-Fi physical evidence requires two correlated observations:

1. A device-side marker containing a nonce and assigned network address.
2. A host-side network probe to that address returning the same nonce.

Credentials are supplied only through named environment variables selected by the trusted adapter. Their values are redacted from process output before persistence. Profiles and evidence contain environment variable names, never values.

## Physical Safety Flow

Physical execution follows this order:

1. Parse and validate the profile.
2. Resolve exactly one target, probe serial, and serial-port identity.
3. Reject ambiguous or missing identities; never choose the first attached device.
4. Preflight tool versions, artifact paths, observation capabilities, and secret presence.
5. Generate a redacted plan and SHA-256 confirmation digest.
6. Require confirmation matching that digest before any flash or attach operation.
7. Acquire exclusive locks for the target, probe, and port.
8. Build and hash the exact native artifact.
9. Flash through the selected trusted adapter.
10. Re-resolve ports by stable USB identity after re-enumeration.
11. Execute each observation independently.
12. Finalize behavior claims and the overall result.
13. Release locks on success, failure, cancellation, SIGINT, SIGTERM, or SIGHUP.

The plan states that flashing overwrites target firmware. Generic backup/restore is not promised because many targets prohibit reliable readback. Cancellation after flash produces an honest incomplete evidence bundle rather than claiming rollback.

## Concurrency and Timeouts

Locks live under a user-scoped LabWired runtime directory and contain process metadata. Stale locks may be reclaimed only after confirming the owning process is gone. All child processes use bounded timeouts and process-group cancellation. Evidence distinguishes timeout, cancellation, provider failure, assertion failure, and missing capability.

## User and Agent Surface

Add one primary command surface:

```text
labwired agent hardware plan --profile PATH
labwired agent hardware run --profile PATH --confirm DIGEST
```

`plan` is read-only. `run` performs physical actions only after matching confirmation. RPC exposes the same CLI engine through manifest rows; it does not reimplement orchestration.

The Agent may help author a profile, but must show the resulting plan and ask for confirmation before running it. Verify mode may inspect profiles and evidence but cannot flash. Plan mode may generate a plan but cannot run it. Act and Debug modes may run after confirmation.

The first implementation writes evidence to disk and streams concise progress through existing RPC tool deltas. A dedicated persistent monitor/evidence UI is a later consumer of the evidence bundle, not part of the core blocker fix.

## Existing Workflow Migration

`scripts/dev-cycle.sh` retains its current environment-variable interface temporarily. It translates supported values into an in-memory version 1 profile and invokes the same runner. Board-specific scripts such as `scripts/profiles/esp32c3-serial.sh` remain examples and test fixtures, not product defaults.

`scripts/desk-hw-physical.sh` becomes a compatibility wrapper over `hardware run`. Existing `probe`, `serial-capture`, `rtt-capture`, `promote`, and claim commands remain available.

## Extension Dependency Modernization

Replace Mocha with Node's built-in `node:test` and `node:assert/strict`:

- Convert the 18 extension unit tests without changing production behavior.
- Remove `mocha` and `@types/mocha`.
- Keep TypeScript and the current compile step.
- Run compiled tests with `node --test`.
- Require `npm audit --audit-level=high` to exit zero.

An npm override is rejected as the primary solution because it hides an incompatible transitive dependency relationship. Bun is not introduced.

## Failure Handling

- Invalid profile: fail before tool lookup or mutation.
- Missing tool or unsupported provider: `blocked` with installation guidance.
- Multiple matching probes or ports: `blocked`; require explicit identity.
- Build failure: preserve compiler diagnostics; do not flash.
- Twin failure: record independently; continue to physical execution only if the approved plan permits it.
- Flash failure: do not run behavior assertions that require the new artifact.
- Observation failure: continue other independent observations, then fail overall.
- Missing secret: record only the environment variable name.
- Evidence write failure: abort before physical mutation when discovered during preflight; after mutation, report the failure to stderr and never claim success.

## Acceptance Criteria

### Generic architecture

- Profile parsing rejects unknown keys, shell strings, unsafe paths, ambiguous identities, and unsupported providers.
- Windows, macOS, and Linux contract tests validate launch descriptors and cancellation behavior.
- CLI and RPC use one orchestration engine.
- Existing environment-driven workflows remain compatible during migration.

### ESP32-C3 native firmware

- PlatformIO builds the Arduino firmware and records its SHA-256.
- Unsupported exact-artifact twin execution is reported honestly, not treated as a false failure or false model success.
- The exact native artifact can satisfy strict acceptance through confirmed physical evidence.

### LED and Wi-Fi

- LED passes only with independent edge evidence meeting profile bounds.
- Wi-Fi passes only when device and host observations share a nonce.
- Serial-only fake LED and Wi-Fi fixtures fail their required physical claims.

### Physical gate

- A fixture test proves missing confirmation cannot flash.
- A fixture test proves multiple probes cannot be auto-selected.
- A fixture test proves cancellation releases locks and retains FAIL evidence.
- A real desk run builds, flashes, captures, and verifies the exact artifact with explicit target identities.

### Extension security

- All converted extension tests pass under `node --test`.
- Extension compile and RPC contract pass.
- `npm audit --audit-level=high` reports zero high or critical vulnerabilities.

### Release gate

- The strict hardware acceptance command has zero skipped required behaviors for the configured physical lab profile.
- The full Agent matrix, extension tests, package checks, actionlint, and clean-worktree checks pass.

## Non-Goals

- Universal emulation of every native firmware format.
- Shipping vendor-specific instrument SDKs in the Agent kit.
- Automatic flashing of whichever board happens to be attached.
- Claiming visible LED behavior from serial logs or register state.
- Persisting Wi-Fi credentials.
- A new monitor UI in the initial blocker fix.
- Replacing existing LabWired flash, capture, or claim engines.
