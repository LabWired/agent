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
