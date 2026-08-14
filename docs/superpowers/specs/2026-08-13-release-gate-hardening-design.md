# Release Gate Hardening Design

## Goal

Turn the current cross-platform source evidence into a predictable release
gate by proving supported upgrades and reinstall lifecycle behavior, bounding
live checks, requiring hosted-service evidence for a release, and removing
deprecated GitHub Actions runtime warnings.

## Scope

This work changes repository tests, workflows, and release documentation. It
does not publish a release, create simulator artifacts, provision credentials,
or claim untested architectures. Public endpoint verification remains a
post-publication gate.

## Bounded Ship Gate

Every external or potentially blocking ship-gate stage runs through one shared
timeout wrapper. The default per-stage bound is configurable through
`LABWIRED_SHIP_STAGE_TIMEOUT`, with a conservative release default. A timeout is
a named failure, writes a stage log, and does not prevent later independent
stages from producing diagnostics. The overall gate always reaches one final
PASS or FAILED line and exits accordingly.

The implementation must work with standard tools available on macOS and Linux.
It cannot assume GNU `timeout` exists on macOS. A small portable Python runner
will execute a command with a timeout, forward its exit status, and use a
distinct timeout status.

## Upgrade Evidence

Upgrade tests install the latest previously published stable Agent kit into an
isolated home, then run the current checkout installer over it. They verify:

- installed version changes from the previous version to the current version;
- `agent version` and `agent doctor` dispatch correctly after the upgrade;
- user-owned configuration and unrelated prefix data survive;
- current ownership manifests exist;
- uninstall after upgrade removes current Agent-owned configuration while
  preserving user-owned data.

The test accepts an explicit previous release archive or version so CI remains
reproducible. Network discovery is not the test contract. A workflow input or
pinned repository variable selects the baseline release. If no baseline is
configured in ordinary pull-request CI, the lane reports `not run`; the release
workflow requires it.

POSIX and Windows get platform-native upgrade scripts. Each writes retained
evidence with the previous version, current version, install logs, lifecycle
result, platform, capabilities, and final result.

## Platform Lifecycle Evidence

The existing clean-install source evidence extends past `doctor`:

1. install;
2. version and doctor;
3. uninstall;
4. verify Agent-owned files are absent;
5. reinstall;
6. verify version and doctor again.

User-owned sentinel files must survive. Each platform records lifecycle output
separately. A failure leaves every expected artifact present with `not-run` or
failure details.

## Hosted Release Evidence

Pull-request tests remain deterministic and may report hosted verification as
`not run` when secrets are unavailable. A dedicated release-readiness workflow
requires hosted credentials and fails if they are absent. It performs an
authenticated doctor probe and a real hosted MCP request on Ubuntu, macOS, and
Windows after installing the candidate.

The hosted job records only status and sanitized diagnostics. Tokens, session
files, and authorization headers are never uploaded. Hosted evidence supplements
source install, upgrade, and deployed endpoint evidence; it replaces none of
them.

## GitHub Actions Runtime Maintenance

All first-party actions move to versions using the current supported Node
runtime. Workflow contract tests reject the deprecated action versions that
caused warnings in the successful cross-platform run. Action references remain
pinned to explicit major versions or immutable SHAs according to repository
policy.

## Error Handling and Evidence Honesty

- Required release inputs missing: fail with a direct message.
- Optional PR-only inputs missing: report `not run`, never PASS.
- Previous release unavailable or checksum mismatch: fail before mutation.
- Upgrade, uninstall, or reinstall failure: retain complete evidence and fail.
- Hosted authentication or MCP failure: fail the release workflow.
- Timed-out ship stage: record stage name, timeout, and failure status.
- Artifact upload always runs but cannot override the originating job result.

## Testing Strategy

Implementation follows test-driven development:

- Add timeout-runner unit tests, including a deliberately hanging fixture.
- Add a ship-gate contract that fails until all blocking stages use the wrapper
  and a final result is guaranteed.
- Add upgrade fixtures representing an older install before implementing
  current upgrade behavior.
- Extend POSIX and Windows evidence contracts before lifecycle implementation.
- Extend structured workflow tests before modifying action versions and release
  workflows.
- Run focused tests, the deterministic local matrix, then GitHub-hosted Ubuntu,
  macOS, Windows PowerShell 5.1, and PowerShell Core jobs.

## Release Decision

A candidate is release-gate ready when one commit has passing source-install,
uninstall/reinstall, configured previous-release upgrade, bounded ship-gate,
and credentialed hosted evidence. A public release is ready only after that same
version also passes deployed-endpoint verification. Simulator and physical
probe support remain separately stated capabilities based on their own evidence.
