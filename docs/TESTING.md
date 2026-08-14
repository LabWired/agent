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
```

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
- Skill tests check the installed skill set and instructions.
- Public install tests check Unix and Windows entry points.
- Prefix and lifecycle tests check safe install, update, and removal.
- Dispatcher tests check `labwired agent` and Core coexistence.
- Smoke tests exercise a temporary installation.
- Live twin tests check behavior when a twin is available.
- Model tests check an optional model provider.
- Windows CI runs the PowerShell contract test.

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
