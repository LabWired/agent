# LabWired Agent

<p align="left">
  <img src="branding/logo.svg" alt="LabWired" width="32" height="32" />
</p>

Write firmware. Run it on a virtual board.

[Product](https://labwired.com/agent.html) · [Playground](https://app.labwired.com/) · [Pro](https://labwired.com/pro.html)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.9-blue)](CHANGELOG.md)

## Install

**macOS / Linux / WSL:**

```bash
curl -fsSL https://labwired.com/install | bash
```

**Windows (PowerShell):**

```powershell
irm https://labwired.com/install.ps1 | iex
```

Then:

```bash
labwired login    # device code → shared tools + hosted model
labwired          # agent with labwired_* MCP tools
```

Local-only (no sign-in) still works with a local model / sim:

```bash
labwired
```

Same one-liner updates. That’s the whole install story.

<details>
<summary>Options (optional)</summary>

```bash
# custom prefix
curl -fsSL https://labwired.com/install | bash -s -- --prefix /opt/labwired

# npm
npx @labwired/agent

# Claude / Codex MCP
claude mcp add labwired --transport http https://api.labwired.com/mcp
```

More: [docs/PORTABLE_INSTALL.md](docs/PORTABLE_INSTALL.md)
</details>

## Surfaces (same tools)

| Surface | How |
|---------|-----|
| **OpenCode agent** | `labwired` or `labwired agent` — skills + MCP |
| **Hosted tools** | `labwired login` then `labwired` → remote `api.labwired.com/mcp` |
| **VS Code** | LabWired extension: debug + **Configure Agent Tools** (same MCP) |
| **Claude / Cursor** | `claude mcp add labwired --transport http https://api.labwired.com/mcp` |

## How it works


1. You describe **any** board and the task  
2. The agent writes firmware  
3. It runs on a virtual board (twin)  
4. Green only if behavior matches — never because the source “looks right”  

Board-agnostic by design. Chip/port/marker come from the task and env
(`LABWIRED_HW_PORT`, `LABWIRED_HW_MARKER`, `LABWIRED_HW_CHIP`) — not a single-MCU product path.

## Commands

| | |
|--|--|
| `labwired` | Start |
| `labwired doctor` | Check install |
| `labwired version` | Version |
| `labwired probe …` | Physical probes + virtual LabWired |
| `labwired serial-capture` | UART/CDC marker window |
| `./demo.sh` | Smoke test |

### Boards (not OpenOCD)

Popular debuggers via **probe-rs** (ST-Link, J-Link, CMSIS-DAP, …).  
Virtual boards via **LabWired sim**. Optional desk promote: flash + serial marker →
`hardware_observed` only.

```bash
labwired probe list
labwired probe chips stm32
labwired probe flash build/app.elf --chip STM32L476RGTx
labwired probe flash build/app.elf --target virtual --chip nucleo-l476rg
labwired probe install-backend   # if probe-rs missing

# Same-binary build → twin → desk (any PlatformIO project)
export LABWIRED_HW_WS=/path/to/project
export LABWIRED_HW_PORT=/dev/ttyACM0
export LABWIRED_HW_MARKER=LABWIRED_OK
scripts/dev-cycle.sh
```

Optional local model:

```bash
ollama pull qwen2.5-coder && ollama serve
labwired
```

## Skills

| | |
|--|--|
| `verify-firmware` | Run the check |
| `diagnose-firmware` | Fail, patch, re-check |
| `inspect-evidence` | Read a result |
| `board-bringup` | Board + wiring |
| `scaffold-firmware` | Blink / serial hello |
| `report-evidence` | Report for you or CI |

## Air-gap

```bash
curl -fsSL https://labwired.com/agent-install.sh | sh -s -- --airgap
```

[mcp/README.md](mcp/README.md)

## Demo

[fixtures/gate1/GATE1.md](fixtures/gate1/GATE1.md) — offline claim shapes  
[fixtures/gate1-live/](fixtures/gate1-live/) — **live** twin red→green

```bash
./demo.sh
scripts/live-gate1.sh    # needs labwired-sim; no monorepo
```

Twin boards (chip names inside the sim): `share/catalog/`.

MIT · [LICENSE](LICENSE)
