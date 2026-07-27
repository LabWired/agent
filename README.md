# LabWired agent

**OpenCode harness** for LabWired’s deterministic firmware oracle.

This repository is the product surface for “agent + verification,” not the platform monorepo.

| Repo | Role |
|------|------|
| **[LabWired/agent](https://github.com/LabWired/agent)** (this repo) | Thin OpenCode distribution: launcher, config, skills, install |
| **[LabWired/skills](https://github.com/LabWired/skills)** | Shared skill sources (vendored here for offline install) |
| **w1ne/labwired** (platform monorepo) | MCP server, builder, board-config, Studio — **not** the agent shell |

> **No OpenCode fork.** Stock [OpenCode](https://opencode.ai) (MIT) + bundled config that registers `@labwired/mcp`, skills, and a local/on-prem model. The IP is the oracle and the claim rules; the harness stays upstream.

## Install

```bash
git clone https://github.com/LabWired/agent && cd agent
./install.sh
labwired doctor
```

`install.sh` installs **pinned** `opencode-ai@1.18.7` (exact pin — bump deliberately), copies config + skills into `~/.config/opencode/`, and installs the `labwired` launcher to `~/.local/bin`.

You also need the **simulator** binary for MCP `run` / `verify` (separate from this launcher):

```bash
curl -fsSL https://labwired.com/install.sh | sh
# If the simulator binary is named `labwired`, point the harness at it:
export LABWIRED_CLI=labwired
```

Default env for the MCP child is `LABWIRED_CLI=labwired-cli` so this agent launcher does not shadow the simulator when both land on PATH as `labwired`.

## Run

```bash
# 1. local model (default: Ollama + Qwen2.5-Coder)
ollama pull qwen2.5-coder && ollama serve

# 2. launch OpenCode with LabWired harness
labwired
```

Commands:

| Command | Purpose |
|---------|---------|
| `labwired` | Start OpenCode |
| `labwired doctor` | Preflight pin, simulator, config, skills |
| `labwired version` | Print harness + OpenCode pin |
| `labwired help` | Usage |

`opencode mcp list` should show the `labwired` server and `labwired_*` tools.

## Skills (Gate 1)

| Skill | Job |
|-------|-----|
| `verify-firmware` | Mandatory-oracle model verification |
| `diagnose-firmware` | Fail first, patch, re-verify |
| `inspect-evidence` | Explain `evidence_ref` / status (read-only) |
| `firmware-verification` | Full verification procedure |

**Claim vocabulary (fail-closed):**

- **model-verified** only when `labwired_verify.status === "model_verified"`
- **failed** / **inconclusive** / **unsupported** as typed by the oracle
- Never upgrade `proven: true` to hardware confirmation

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `LABWIRED_MODEL_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible model endpoint |
| `LABWIRED_MODEL_KEY` | `local` | API key (Ollama ignores it) |
| `LABWIRED_BUILDER_URL` | *(empty)* | Builder for source→ELF + some verify paths |
| `LABWIRED_CLI` | `labwired-cli` | Simulator binary the MCP shells out to |
| `OPENCODE_PIN` | `1.18.7` | Expected OpenCode version for `doctor` |

## Layout

```
bin/labwired                 branded launcher + doctor/version
config/opencode.json         default profile
config/opencode.airgap.json  on-prem / ITAR profile
config/AGENTS.md             standing claim rules
skills/                      Gate 1 skills (OpenCode discovery)
fixtures/gate1/              red→green oracle demo sources
install.sh                   pin OpenCode + install config/skills/launcher
```

## Air-gapped / ITAR

Use `config/opencode.airgap.json` at a **managed** path (`/etc/opencode/opencode.json` or macOS Application Support). Restricts providers to the local model; set in-vault `LABWIRED_MODEL_URL` / `LABWIRED_BUILDER_URL`. The oracle needs **no AI** in the vault.

## What is intentionally not here

- Platform MCP/builder implementation (monorepo)
- Studio / Playground UI
- Hardware confirmation gateway
- Enterprise Helm / SSO

Those are separate products and gates. This repo is **only** the OpenCode harness.
