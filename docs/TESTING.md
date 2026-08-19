# Test LabWired Agent

## Main commands

```bash
npm test
npm run test:unit
npm run test:dispatcher
npm run test:node18-min
npm run test:agent-lifecycle
npm run test:public-install-safety
npm run test:install
npm run test:llm
npm run test:tool-names
npm run test:develop
npm run test:develop:acceptance
npm run test:develop:agent
npm run test:develop:release
```

`test:develop:mechanics` is an alias of `test:develop:acceptance`.

`npm test` runs the current matrix in `tests/all.sh`. Read that file for the
authoritative lane list. Do not copy a test count into documentation because
the matrix changes.

Node.js 18.0 predates the `node --test` command-line flag. Its minimum-runtime
contract therefore imports the `node:test` files directly:

```bash
npx --yes node@18.0.0 tests/hardware-cli-node.test.mjs
npx --yes node@18.0.0 tests/hardware-runner.test.mjs
```

## Test lanes

- Harness tests check command behavior and evidence rules.
- `run-bounded.sh` checks the bounded-run helper itself.
- Skill tests check the installed skill set and instructions
  (`skills-inventory.sh`, `skills-verify-all.sh`, `develop-skill.sh`).
- Develop lanes check the `develop` workflow: `develop-acceptance-smoke.sh`
  (npm `test:develop:acceptance`) and the grounded hosted-agent certification
  `develop-agent-e2e.sh` (npm `test:develop:agent`; `test:develop:release`
  requires completeness). The certification needs hosted auth plus explicit
  `LABWIRED_DEVELOP_KNOWLEDGE_READY=1` and `LABWIRED_DEVELOP_TWIN_READY=1`
  after provisioning; without them it reports a missing prerequisite, never a
  pass.
- Hosted lanes check hosted configuration and auth honesty
  (`hosted-config.sh`, `hosted-auth-probe.sh`).
- `agents-tool-search.sh`, `desktop-session.sh`, `compose-helpers.sh`, and
  `smoke-doctor-gate.sh` check tool search, desktop session, compose helpers,
  and the doctor gate.
- Smoke waves (`scripts/smoke-wave-a.sh`, `scripts/smoke-remaining.sh`)
  exercise temporary installations.
- `ship-gate` (`scripts/ship-gate.sh`, bounded by `tests/ship-gate-bounds.sh`)
  is the release superlane: doctor, whoami, assert-status, live twin gate
  (`scripts/live-gate1.sh`), compose, knowledge, skill packs, the develop-first
  default, diagram/desk-hw/knowledge smokes, and the optional grounded
  hosted-agent certification.
- Public package lanes check docs and scope (`scripts/check-public-package.sh`,
  `public-package-scope.sh`).
- Public install tests check Unix and Windows entry points.
- Prefix and lifecycle tests check safe install, update, and removal.
- Dispatcher tests check `labwired agent` and Core coexistence.
- RPC lanes check agent resolution, contract, tool streaming, probe
  resolution, claim shape, and promotion (`rpc-*.sh`); `tools-manifest.sh`
  checks the tool manifest.
- Smoke tests exercise a temporary installation.
- Live twin tests check behavior when a twin is available.
- Model tests check an optional model provider.
- Windows CI runs the PowerShell contract test.
- Generic hardware Node tests run with `node --test tests/hardware-*.test.mjs`.
- `hardware-cli.sh` and `hardware-legacy-compat.sh` cover CLI/RPC parity and
  legacy translation.
- `hardware-release-contract.sh` exercises deterministic positive and negative
  behavior evidence; strict mode needs an operator-supplied lab profile and
  otherwise reports a block, never a pass.
- `hardware-debug-traps.sh` checks debug diagnostics preserve exit codes.
- `hardware-public-docs.sh` and `hardware-matrix-order.sh` check hardware docs
  and hermetic matrix ordering.
- `probe-exact-flash.sh` checks artifact hashes and exact provider arguments.
- `windows-hardware-contract.ps1` checks native PowerShell helpers and dispatch;
  it runs only on a lane with PowerShell.
- `upgrade-contract.sh` drives `upgrade-smoke.sh` across upgrade scenarios.
- `release-evidence-contract.js` (with `hosted-release-contract.js` and
  `action-runtime-pins-contract.js`) checks the release evidence model below.
- `demo.sh` runs the scripted demo; `fw-usecase-qa.sh` runs the firmware
  use-case gate; `gap-ready-qa.sh` runs the editor+probe product gate and needs
  `LABWIRED_EDITOR_ROOT` and a connected ESP debug probe.
- `airgap-install.sh` is a manual airgap lane; see `docs/SELF_HOST.md`.

Deterministic lanes must pass in CI. A physical board, paid model, or live
service may be unavailable. Its optional lane must print `not run`. Missing
input must never be reported as a pass.

Never commit API keys. Set optional keys in the environment or in a local
secret file outside the repository.

## Cross-platform release evidence

Source-install evidence proves the checked-out commit before publication.
Separate Ubuntu, macOS, and Windows jobs install into isolated homes and upload:

- `labwired-agent-source-ubuntu`
- `labwired-agent-source-macos`
- `labwired-agent-source-windows`

All three artifacts must belong to the same commit. Each contains
`platform.txt`, `install.txt`, `version.txt`, `doctor.txt`,
`capabilities.txt`, and `result.txt`. A platform is green only when
`result.txt` contains `PASS`. Read `capabilities.txt` for simulator and probe
availability, and use the architecture recorded in `platform.txt` as the
tested architecture claim.

Deployed-endpoint evidence is a separate, manually dispatched workflow run
after publication. It downloads the public macOS/Linux and Windows installer
URLs, checks the requested published version, and uploads:

- `labwired-agent-deployed-ubuntu`
- `labwired-agent-deployed-macos`
- `labwired-agent-deployed-windows`

Source evidence cannot prove that the public endpoints were updated. Deployed
evidence cannot replace same-commit source tests. A public release needs both.

## Credentialed hosted release readiness

Ordinary pull request hosted lanes may report `not run` when live-service
credentials are unavailable. The manually dispatched `release-readiness`
workflow is mandatory for release readiness: all three platform jobs must pass
before publishing a candidate.

Dispatch the workflow from the candidate commit or tag. Supply the exact
`candidate_version`, the stable `previous_version`, and an HTTPS archive URL
plus SHA256 for the previous Ubuntu, macOS, and Windows release. The workflow
rejects empty or malformed release inputs before checkout. Configure these
GitHub Actions secrets:

- `LABWIRED_RELEASE_ACCESS_TOKEN`: a release-verification hosted bearer.
- `LABWIRED_RELEASE_PROJECT`: the project used for hosted verification.

Missing credentials fail the release jobs; they never turn the checks into an
optional skip. Credentials exist only in the validation and hosted-check step
processes. The jobs do not append them to the Actions environment, and they
remove the temporary hosted session before uploading evidence.

Ubuntu, macOS, and Windows each install the checked-out candidate, require
`labwired agent doctor` to report authenticated hosted tools, make a real MCP
`tools/list` request, and then exercise the pinned previous-to-candidate
upgrade. Windows runs native readiness and upgrade evidence under Windows
PowerShell 5.1 and PowerShell Core, records both engine versions, and uses the
installed cross-platform Agent launcher for the authenticated hosted-doctor
probe. The uploaded artifacts are:

- `labwired-agent-release-readiness-ubuntu`
- `labwired-agent-release-readiness-macos`
- `labwired-agent-release-readiness-windows`

Before checkout, each job initializes `result.txt` to `FAIL` under the runner's
temporary directory and validates every credential and release input. Missing
required values therefore fail immediately. Checkout cannot clean this evidence
root, so validation, checkout, and later failures retain negative evidence.
Artifacts include sanitized `hosted-status.txt` and `mcp-result.txt`,
`platform.txt`, `capabilities.txt`, `result.txt`, and the platform upgrade
evidence directory. They exclude raw logs, configuration, session, environment,
token, and HTTP-header files. A release reviewer must confirm top-level and
upgrade `result.txt` files are `PASS` for every platform.
