# LabWired Firmware Agent

**The easy way to build hardware.**

Install an agent that writes firmware and **stops at a real gate**. A model may
draft code. It may not claim the firmware works until LabWired’s oracle returns
`status: model_verified` on the exact binary. Compile success, UART chatter, or
“looks fine in the source” is not a pass.

This repo is a thin [OpenCode](https://opencode.ai) distribution (MIT, no fork):
launcher, config, skills, and MCP wiring. The sim and MCP server live elsewhere.

| Repo | Role |
|------|------|
| **[LabWired/agent](https://github.com/LabWired/agent)** (this) | Firmware agent shell: install, skills, claim rules |
| **w1ne/labwired** | Simulator, MCP, builder, Studio |
| [labwired.com/pro.html](https://labwired.com/pro.html) | Paid workbench (editor loop, private runs) |

## Install

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

Resolution order: `LABWIRED_CLI`, `LABWIRED_SIM`, then PATH names that exist
(`labwired` if it is not this agent, `labwired-sim`, `labwired-cli`). No fictional
defaults.

| Name | Meaning |
|------|---------|
| `labwired` (this repo) | Agent launcher → OpenCode |
| `LABWIRED_CLI` / sim | Simulator the MCP calls |
| `opencode` | Pinned OpenCode CLI |

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
| `./demo.sh` | Harness smoke tests |

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

## Skills

| Skill | Job |
|-------|-----|
| `verify-firmware` | Run the oracle; report only its status |
| `diagnose-firmware` | Capture a failing verify, patch, re-verify |
| `inspect-evidence` | Read `evidence_ref` / verify JSON (no inventing) |

## Prefer Claude / Codex instead?

Use the hosted MCP and skip this shell:

```bash
claude mcp add labwired --transport http https://api.labwired.com/mcp
codex mcp add labwired --url https://api.labwired.com/mcp && codex mcp login labwired
```

Same oracle rules. This repo is the **turnkey local shell** (OpenCode + skills + pin).

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
config/opencode.json      default profile
config/opencode.airgap.json
config/AGENTS.md          claim rules
skills/                   verify / diagnose / inspect
fixtures/gate1/           red → green demo sources
lib/                      resolve-sim, resolve-mcp, assert-status
tests/harness.sh
demo.sh
install.sh
mcp/                      air-gap vendor notes
```

## Not in this repo

Platform MCP/builder, Studio UI, hardware confirmation, Enterprise deploy.

MIT — see [LICENSE](LICENSE). Product site: [labwired.com](https://labwired.com).
