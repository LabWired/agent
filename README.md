# LabWired Firmware Agent — the easiest way to write firmware

<p align="left">
  <img src="branding/logo.svg" alt="LabWired" width="32" height="32" />
</p>

An AI agent that writes firmware and checks it on a virtual board before you
touch hardware. Install free. Works offline with a local model, or plug Claude /
Codex into the same tools.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/based%20on-OpenCode-black)](https://opencode.ai)

## Install

```bash
git clone https://github.com/LabWired/agent && cd agent
./install.sh
labwired doctor
./demo.sh
labwired
```

That’s it. The installer sets up the agent and skills. For full simulation, also
install the LabWired simulator (or set `LABWIRED_CLI` to your sim binary):

```bash
curl -fsSL https://labwired.com/install.sh | sh
```

Already using Claude or Codex? Skip this repo and connect MCP instead:

```bash
claude mcp add labwired --transport http https://api.labwired.com/mcp
codex mcp add labwired --url https://api.labwired.com/mcp
```

## What it does

1. You describe the board and the job  
2. The agent writes firmware  
3. It runs the firmware on a digital twin of the chip  
4. You only get a green check when the behavior actually matches  

No “looks fine in the source” passes. Compile success alone is not enough.

## Skills included

| Skill | What it’s for |
|-------|----------------|
| `verify-firmware` | Run the check; only report what the sim says |
| `diagnose-firmware` | Fail first, fix, check again |
| `inspect-evidence` | Explain a result without inventing details |
| `board-bringup` | Pick a board and wire a valid setup |
| `scaffold-firmware` | Minimal blink or serial “hello” |
| `report-evidence` | Write a clear report for you or CI |

## Commands

| Command | Purpose |
|---------|---------|
| `labwired` | Start the agent |
| `labwired doctor` | Check install |
| `labwired version` | Version info |
| `./demo.sh` | Smoke test |

Optional local model (default path):

```bash
ollama pull qwen2.5-coder && ollama serve
labwired
```

## Air-gapped install

```bash
./install.sh --airgap
```

See [mcp/README.md](mcp/README.md) for vendoring the MCP server with no network.

## How verification works (for CI)

After a check, status is one of: `model_verified`, `failed`, `inconclusive`,
`unsupported`. Only `model_verified` means the twin saw the expected behavior.

```bash
labwired assert-status model_verified < verify.json
```

Demo red→green fixture: [fixtures/gate1/GATE1.md](fixtures/gate1/GATE1.md).

## Links

- Product site: [labwired.com](https://labwired.com)
- Pro workbench: [labwired.com/pro.html](https://labwired.com/pro.html)
- Browser Playground: [app.labwired.com](https://app.labwired.com/)
- Simulator & platform: [github.com/w1ne/labwired](https://github.com/w1ne/labwired)

## Not in this repo

The big platform (builder, Studio, enterprise deploy) lives in the main LabWired
monorepo. This repo is the open agent you install and run.

MIT — see [LICENSE](LICENSE).
