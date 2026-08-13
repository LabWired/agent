# Test LabWired Agent

## Main commands

```bash
npm test
npm run test:unit
npm run test:dispatcher
npm run test:agent-lifecycle
npm run test:public-install-safety
npm run test:install
npm run test:llm
```

`npm test` runs the current matrix in `tests/all.sh`. Read that file for the
authoritative lane list. Do not copy a test count into documentation because
the matrix changes.

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
