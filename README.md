# LabWired Agent

<p align="left">
  <img src="branding/logo.svg" alt="LabWired" width="32" height="32" />
</p>

Write firmware. Run it on a virtual board.

[Product](https://labwired.com/agent.html) · [Playground](https://app.labwired.com/) · [Pro](https://labwired.com/pro.html)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-blue)](CHANGELOG.md)

## Install

**Easy on every platform** — one portable prefix, thin PATH shim.

| OS | One-liner (Cursor CLI style) |
|----|------------------------------|
| **macOS / Linux / WSL2** | `curl -fsSL https://labwired.com/install \| bash` |
| **Windows** (PowerShell) | `irm 'https://labwired.com/install?win32=true' \| iex` |
| **Any** (Node 18+) | `npx @labwired/agent` |

**WSL:** use the **bash** line *inside* the distro (same as Cursor). USB → `usbipd`.

Then (install already proved with **smoke**):

```bash
labwired smoke     # claim gate + sim + skills
labwired           # start agent
labwired update    # self-update (like Cursor agent update)
```

```powershell
labwired smoke
labwired
labwired update
```

Portable root anywhere:

```bash
curl -fsSL https://labwired.com/install | bash -s -- --prefix /opt/labwired
# or from git checkout:
LABWIRED_HOME=./.lw ./install.sh --full && ./.lw/userbin/labwired smoke
```

```text
$LABWIRED_HOME/   (~/.labwired or %USERPROFILE%\.labwired)
  agent/  tools/sim  tools/probe-rs  bin/  env.sh|env.ps1  MANIFEST.json
```

| Flag | Meaning |
|------|---------|
| `--full` / `-Full` | Agent + tools into the prefix (default) |
| `--prefix DIR` / `-Prefix` | Custom root (USB, CI, `D:\labwired`) |
| `--minimal` / `-Minimal` | Kit only |
| `--airgap` / `-Airgap` | Vendored MCP |

```bash
labwired package info
labwired install-deps
labwired package uninstall --yes
```

Full matrix (Windows twin = hosted MCP until Windows sim prebuild ships):  
[docs/PORTABLE_INSTALL.md](docs/PORTABLE_INSTALL.md)

Claude / Codex:

```bash
claude mcp add labwired --transport http https://api.labwired.com/mcp
codex mcp add labwired --url https://api.labwired.com/mcp
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
