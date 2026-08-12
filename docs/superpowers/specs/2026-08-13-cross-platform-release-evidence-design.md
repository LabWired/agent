# Cross-Platform Release Evidence Design

## Goal

Make LabWired Agent release readiness demonstrable on GitHub-hosted macOS,
Ubuntu, and Windows systems. A release candidate must pass its public install
path, advertised command dispatch, non-interactive health checks, package
safety checks, and platform-appropriate smoke tests on every supported OS.

## Scope

This work covers the Agent kit and its public installers. It fixes the release
blockers already reproduced in the current repository and adds durable CI
evidence. It does not add a Windows simulator build. When no native Windows
simulator artifact exists, Windows must accurately identify hosted verification
or WSL as the supported twin path.

## Release Contract

Every supported operating system must prove the following from an isolated
temporary user environment:

1. The public installer completes without relying on a developer checkout.
2. `labwired agent version` reaches the Agent version command.
3. `labwired agent doctor` reaches the Agent doctor command and reports missing
   optional dependencies as warnings rather than false successes.
4. The installed dispatcher preserves argument boundaries and strips the
   `agent` product prefix exactly once.
5. Package safety scanning passes without publishing private workstation paths,
   unintended personal data, or development-only files.
6. Platform diagnostics and test logs are retained as workflow artifacts.

The macOS and Ubuntu jobs exercise the shell installer and POSIX dispatcher.
The Windows job exercises the PowerShell installer and both Windows PowerShell
5.1 and PowerShell Core dispatch paths. Each job uses isolated install, config,
cache, and home directories so an existing developer installation cannot hide
missing files or stale-launcher defects.

## Components

### Product Dispatcher

The user-facing `labwired` command remains the single product dispatcher. Its
`agent` branch delegates to the platform-specific Agent launcher after removing
the product prefix. Direct Agent launchers continue to accept Agent subcommands
such as `doctor` and `version`. Regression tests will reproduce the stale-shim
failure where `doctor` was incorrectly forwarded as an Agent working directory.

### Package Boundary

The public-package checker defines what may ship. Development plans and editor
extension dependencies must not make the Agent package fail for unrelated
content. The npm `files` allowlist remains authoritative for the tarball, while
repository-wide safety checks use explicit, documented exclusions only for
non-published development material. Published files receive the strictest scan.

### Lifecycle Behavior

Lifecycle tests must isolate model and configuration state. Assertions will
inspect the installed configuration contract rather than inherit mutable state
from the developer machine. A failure must name the mismatched field and the
actual value.

### CI Evidence Matrix

The primary workflow gains clean-install evidence jobs for Ubuntu, macOS, and
Windows. Each job records platform metadata, installer output, version output,
doctor output, and smoke-test output into a platform-specific artifact. The
workflow summary identifies whether local simulation was exercised or whether
the supported hosted/WSL fallback applies.

Credentialed hosted-service verification is an optional job. It reports
`not run` when secrets are absent and cannot turn an untested path into a pass.
It supplements but does not replace installer and dispatcher evidence.

## Error Handling and Honesty

Required dependencies, broken dispatch, corrupt configuration, and failed
installer steps exit nonzero. Optional simulator or physical-probe absence is a
warning only where documentation explicitly permits the hosted or WSL path.
Tests must reject output containing `not ready` even if it also contains the
word `ready`.

CI evidence collection runs even after a test failure so the failing platform's
logs remain available. Artifact upload itself must not conceal the original test
exit status.

## Testing Strategy

Changes follow test-driven development:

- Add a failing installed-shim regression test before changing dispatch logic.
- Preserve the failing package-safety fixtures while separating published and
  development-only scan scopes.
- Add a focused lifecycle regression that demonstrates configuration-state
  leakage before correcting isolation.
- Add workflow/static contract tests for all required matrix jobs and artifact
  names before editing the workflow.
- Run focused tests after each fix, then the complete local suite.
- Use the GitHub-hosted matrix as the final macOS, Ubuntu, and Windows evidence.

## Release Decision

The Agent is cross-platform release-ready only when all three clean-install jobs
pass for the same commit and their evidence artifacts are present. Windows is
described as native Agent support with hosted or WSL twin verification until a
native simulator artifact is published. Any weaker state is reported as a
release candidate or preview, not as full three-platform parity.
