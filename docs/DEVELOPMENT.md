# Develop LabWired Agent

## Set up

Clone the repository and install npm metadata:

```bash
git clone https://github.com/LabWired/agent.git
cd agent
npm install
```

The npm postinstall command is a no-op. It does not install or change the
LabWired product.

## Run deterministic tests

These tests do not require a board, paid model, or live service:

```bash
npm run test:unit
npm run test:dispatcher
npm run test:agent-lifecycle
```

## Run the install smoke test

```bash
npm run test:install
```

This test uses a temporary install prefix. It may download tools.

## Run a live twin test

The gate scripts (`scripts/live-gate1.sh`, `scripts/import-multi-smoke.sh`,
`scripts/ship-gate.sh`) run from a source checkout of the repository, not
from the installed npm package. They need `tests/` and `fixtures/`, which
the package does not ship.

```bash
bash scripts/live-gate1.sh
```

This test needs the configured twin service or a local simulator.

## Run optional checks

Physical-board checks need a supported board and probe. Model checks need
`DEEPINFRA_API_KEY`.

```bash
LABWIRED_HW_WS=/path/to/platformio-project bash scripts/dev-cycle.sh
bash tests/llm-deepinfra.sh
```

If required input is absent, an optional lane must say `not run`. It must not
report a pass.

## Check Windows behavior

Windows CI runs `tests/windows-contract.ps1` in PowerShell. Run the same script
on Windows before changing the installer or command dispatcher.

See [Testing](TESTING.md) for the complete lane list.
