# LabWired Firmware Agent

<p align="left">
  <img src="branding/logo.svg" alt="LabWired" width="32" height="32" />
</p>

**The easiest way to write firmware.**

LabWired (the product) is the easy way to build hardware — twins, Playground, CI.
This repo is the **agent shell**: draft firmware with a model, then stop at a real
gate. A model may draft code. It may not claim the firmware works until LabWired’s
oracle returns `status: model_verified` on the exact binary. Compile success, UART
chatter, or “looks fine in the source” is not a pass.

**Agent proposes; oracle disposes.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode-based](https://img.shields.io/badge/OpenCode-harness-black)](https://opencode.ai)
[![Skills](https://img.shields.io/badge/skills-6-informational)](skills/)

This repo is a thin [OpenCode](https://opencode.ai) distribution (MIT, **no fork**):
launcher, config, skills, and MCP wiring. The sim and MCP server live elsewhere.

| Repo | Role |
|------|------|
| **[LabWired/agent](https://github.com/LabWired/agent)** (this) | Firmware Agent kit: install, skills, claim rules |
| **[w1ne/labwired](https://github.com/w1ne/labwired)** | Simulator, MCP, builder, Studio |
| [labwired.com/pro.html](https://labwired.com/pro.html) | Pro workbench (editor loop, private runs) |
| [Playground](https://app.labwired.com/) | Browser twin, no install |

## Install in 60 seconds

```bash
git clone https://github.com/LabWired/agent && cd agent
./install.sh
labwired doctor
./demo.sh
labwired
```

`install.sh` pins `opencode-ai@1.18.7`, installs the `labwired` launcher to
`~/.local/bin`, and copies config + skills into `~/.config/opencode/`.

Air-gap (vendored MCP — see [mcp/README.md](mcp/README.md)):

```bash
./install.sh --airgap
```

### Simulator (separate binary)

MCP `run` / `verify` need the LabWired simulator, not this launcher:

```bash
curl -fsSL https://labwired.com/install.sh | sh
# or:
export LABWIRED_CLI=/path/to/labwired-simulator
```

## What you get

1. **Turnkey agent shell** — stock OpenCode + LabWired branding + claim rules  
2. **MCP to the oracle** — `@labwired/mcp` (or vendored air-gap entry)  
3. **Fail-closed claims** — `model_verified` only from `labwired_verify`  
4. **Skill pack** — Gate 1 verify loop + board/scaffold/report workflow  

## Skills

| Skill | Job |
|-------|-----|
| `verify-firmware` | Run the oracle; report only its status |
| `diagnose-firmware` | Capture a failing verify, patch, re-verify |
| `inspect-evidence` | Read `evidence_ref` / verify JSON (no inventing) |
| `board-bringup` | Board/MCU, diagram, pins/buses before claims |
| `scaffold-firmware` | Minimal blink / UART hello skeleton |
| `report-evidence` | Human/CI report from verify JSON; never invent pass |

## Binary story

| Name | Meaning |
|------|---------|
| `labwired` (this repo) | Agent launcher → OpenCode |
| `LABWIRED_CLI` / sim | Simulator the MCP calls |
| `opencode` | Pinned OpenCode CLI |

Resolution order for the sim: `LABWIRED_CLI`, `LABWIRED_SIM`, then PATH names that
exist (`labwired` if it is not this agent, `labwired-sim`, `labwired-cli`). No fictional defaults.

## Run

```bash
ollama pull qwen2.5-coder && ollama serve   # default local model
labwired
```

| Command | Purpose |
|---------|---------|
| `labwired` | Start OpenCode with this config |
| `labwired doctor` | Check pin, sim, config, skills |
| `labwired version` | Harness + OpenCode pin |
| `labwired assert-status <status> [file]` | Exit 0 only if JSON `status` matches |
| `./demo.sh` | Harness smoke + Gate 1 claim artifacts |

## Claims (fail-closed)

After every `labwired_verify`:

| Status | Meaning |
|--------|---------|
| `model_verified` | Only status that may be reported as model-verified |
| `failed` | Behavior contradicted the oracle, or the firmware faulted |
| `inconclusive` | Missing evidence or runner failure |
| `unsupported` | Unmodeled instruction, MMIO, peripheral, or clause |

- `proven: true` is a deprecated alias for `model_verified`. Not hardware proof.
- CI / humans: `labwired assert-status model_verified < verify.json`

Standing rules live in [config/AGENTS.md](config/AGENTS.md).

## Gate 1 proof (public)

Red → green claim story with offline JSON artifacts:

```bash
./demo.sh
# or:
bin/labwired assert-status failed fixtures/gate1/artifacts/broken.verify.json
bin/labwired assert-status model_verified fixtures/gate1/artifacts/fixed.verify.json
```

Full walkthrough: [fixtures/gate1/GATE1.md](fixtures/gate1/GATE1.md).

## Prefer Claude / Codex instead?

Use the hosted MCP and skip this shell:

```bash
claude mcp add labwired --transport http https://api.labwired.com/mcp
codex mcp add labwired --url https://api.labwired.com/mcp && codex mcp login labwired
```

Same oracle rules. This repo is the **turnkey local shell** (OpenCode + skills + pin).

## Air-gap / ITAR

`./install.sh --airgap` refuses naked `npx` unless you vendor MCP or set
`LABWIRED_MCP_ENTRY`. See [mcp/README.md](mcp/README.md).

## Env

| Var | Default | Purpose |
|-----|---------|---------|
| `LABWIRED_MODEL_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible model |
| `LABWIRED_MODEL_KEY` | `local` | API key (Ollama ignores it) |
| `LABWIRED_BUILDER_URL` | empty | Source → ELF when needed |
| `LABWIRED_CLI` / `LABWIRED_SIM` | resolved if present | Simulator binary |
| `LABWIRED_MCP_ENTRY` | optional | Absolute MCP `index.js` (air-gap) |
| `OPENCODE_PIN` | `1.18.7` | Expected OpenCode version |

## Layout

```
bin/labwired              launcher + doctor / version / assert-status
branding/                 logo + help banner
config/opencode.json      default profile
config/opencode.airgap.json
config/AGENTS.md          claim rules
skills/                   six skills (gate + workflow)
fixtures/gate1/           red → green demo + claim artifacts
lib/                      resolve-sim, resolve-mcp, assert-status
tests/harness.sh
demo.sh
install.sh
mcp/                      air-gap vendor notes
```

## Not in this repo

Platform MCP/builder monorepo, Studio UI, hardware confirmation, Enterprise Helm/SSO.

## Links

- Product: [labwired.com](https://labwired.com)
- Pro: [labwired.com/pro.html](https://labwired.com/pro.html)
- Playground: [app.labwired.com](https://app.labwired.com/)
- Core sim: [github.com/w1ne/labwired-core](https://github.com/w1ne/labwired-core)

MIT — see [LICENSE](LICENSE).
