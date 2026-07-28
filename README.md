# LabWired Agent

<p align="left">
  <img src="branding/logo.svg" alt="LabWired" width="32" height="32" />
</p>

Write firmware. Run it on a virtual board.

[Product](https://labwired.com/agent.html) · [Playground](https://app.labwired.com/) · [Pro](https://labwired.com/pro.html)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-blue)](CHANGELOG.md)

## Install

```bash
curl -fsSL https://labwired.com/agent-install.sh | sh
labwired
```

```bash
# or
npm i -g @labwired/agent && labwired
```

```bash
# or
git clone https://github.com/LabWired/agent && cd agent && ./install.sh
```

Claude / Codex:

```bash
claude mcp add labwired --transport http https://api.labwired.com/mcp
codex mcp add labwired --url https://api.labwired.com/mcp
```

Simulator (for full checks):

```bash
curl -fsSL https://labwired.com/install.sh | sh
```

## How it works

1. You describe the board and the task  
2. The agent writes firmware  
3. It runs on a virtual board  
4. Green only if behavior matches  

## Commands

| | |
|--|--|
| `labwired` | Start |
| `labwired doctor` | Check install |
| `labwired version` | Version |
| `labwired probe …` | Boards: probes + virtual LabWired |
| `./demo.sh` | Smoke test |

### Boards (not OpenOCD)

Popular debuggers via **probe-rs** (ST-Link, J-Link, CMSIS-DAP, …).  
Virtual boards via **LabWired sim** (validation device).

```bash
labwired probe list
labwired probe chips stm32
labwired probe flash build/app.elf --chip STM32L476RGTx
labwired probe flash build/app.elf --target virtual --chip nucleo-l476rg
labwired probe install-backend   # if probe-rs missing
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

[fixtures/gate1/GATE1.md](fixtures/gate1/GATE1.md)

```bash
./demo.sh
```

MIT · [LICENSE](LICENSE)
